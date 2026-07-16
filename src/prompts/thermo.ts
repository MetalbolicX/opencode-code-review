/**
 * Thermo-Nuclear Review Profile
 *
 * Centralised rubric and marker for the `thermo-nuclear` review posture.
 * Injected into the `code-quality` dimension and orchestrator agent prompts
 * only when `config.profile === "thermo-nuclear"`.
 *
 * Functional safety boundary: these simplifications MUST NOT weaken
 * behaviour, input validation, error handling, security, accessibility,
 * or performance-critical paths.
 */

import type { ReviewProfile } from "../config.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Tag applied to every thermo-nuclear finding so downstream consumers can
 * distinguish it from other review findings. */
export const THERMO_MARKER = "[thermo]";

// ---------------------------------------------------------------------------
// Rubric content (bilingual)
// ---------------------------------------------------------------------------

const THERMO_RUBRIC_EN = `
## Thermo-Nuclear Simplification Lens

Apply aggressive structural simplification WITHOUT touching behaviour,
validation, security, accessibility, or performance contracts.

### Code-Judo (Structural Simplification)
Prefer code that reads like what it does. Collapse layers that exist only
to satisfy an architectural pattern rather than a real abstraction boundary.
Redundant indirection — even if technically correct — increases maintenance
load and obscures intent. Use \`[thermo]\` when you remove a unnecessary
abstraction layer.

### Spaghetti Branching Detection
Long conditional chains (>3 branches), deeply nested if/else trees, and
flag-driven state machines are prime candidates for simplification. Prefer
early returns, guard clauses, and table-driven dispatch. Flag-driven logic
that accumulates over time is a smell — consider collapsing state into a
cleaner representation.

### 1000-Line File Growth Guard
Files exceeding ~1000 lines (excluding tests and generated content) should
be examined for cohesion. Large files are not inherently wrong but often
signal that multiple concerns are co-located without intentional separation.
Propose splitting when a file does more than one clearly separable job.

### Unnecessary Abstractions
Abstractions that exist "for future flexibility" but add no current value
should be removed. This includes:
- Type aliases that mirror a primitive with no additional constraint
- Wrapper functions that add no behaviour beyond the underlying call
- Intermediate interfaces used by only one implementation

### Type & Boundary Cleanliness
Prefer types that make illegal states unrepresentable. When a union type
covers all real cases with no impossible states, prefer it over a boolean
flag plus a separate payload. Avoid \`any\` escape hatches that bypass the
type checker unless absolutely necessary.

### Canonical-Layer Ownership
Each module/function should belong to one clear layer (e.g., domain logic,
port/adapter boundary, infrastructure). Crossing layer boundaries without
explicit intent (e.g., infrastructure calling domain helpers directly) muddies
ownership. Flag cross-layer calls that lack a documented rationale.

### Avoidable Sequential Orchestration
Sequential \`await\` chains where operations are independent can be run in
parallel. Also flag cases where a retry loop, back-off strategy, or bulk
operation could replace a sequential fetch loop.

### Functional Safety Boundary (mandatory — never bypass)
Thermo simplifications MUST NOT weaken:
- Behaviour: output, return value, or observable side effects
- Input validation: any checking done on public API surfaces
- Error handling: how failures are surfaced and recovered
- Security: auth, access control, injection defence, secrets handling
- Accessibility: ARIA semantics, keyboard navigation, screen-reader contracts
- Performance: hot-path latency, memory allocation in tight loops

If a simplification risks any of the above, skip it and tag the finding
\`[thermo]\` without a simplification recommendation.
`.trim();

const THERMO_RUBRIC_ZH = `
## 热核精简视角

在不改变行为、验证、安全性、可访问性或性能契约的前提下，执行激进的结构性简化。

### Code-Judo（结构性简化）
优先选择"所见即所得"的代码。折叠那些仅为满足某种架构模式而存在、而非真正抽象边界服务的层级。
冗余的间接调用——即使技术正确——也会增加维护负担并掩盖意图。移除不必要的抽象层级时使用 \`[thermo]\` 标记。

### 意面分支检测
冗长的条件链（>3个分支）、深层嵌套的 if/else 结构，以及标志驱动的状态机是简化的首选目标。
优先使用早期返回、卫语句和表驱动分发。随着时间积累的标志驱动逻辑是一种代码坏味——考虑将其折叠为更清晰的表示。

### 1000行文件增长守卫
超过约 1000 行的文件（不含测试和生成内容）应接受内聚性审查。大文件本身并无错误，但往往表明多个关注点被无意识地混置。
当一个文件承担了多个可分离的工作时，应提出拆分建议。

### 不必要的抽象
为"未来灵活性"而存在、但当前毫无价值的抽象应当移除。包括：
- 没有任何额外约束的、仅映射原始类型的类型别名
- 在底层调用之外不增加任何行为的包装函数
- 仅被一个实现使用的中间接口

### 类型与边界清洁性
优先使用使非法状态无法表示的类型。当联合类型覆盖了所有真实情况且无非法状态时，优先使用它而非布尔标志加单独载荷。
避免绕过类型检查器的 \`any\` 逃生舱——除非绝对必要。

### 规范层所有权
每个模块/函数应属于一个明确的层级（如：领域逻辑、端口/适配器边界、基础设施）。
跨越层级边界而没有明确意图（如：基础设施直接调用领域帮助函数）的调用会混淆所有权。
标记缺乏文档说明的跨层调用。

### 可避免的顺序编排
相互独立的操作若采用顺序 \`await\` 链，可改为并行运行。
同样标记那些可以用重试循环、退避策略或批量操作替代的顺序获取循环。

### 功能安全边界（强制——永不绕过）
热核精简不得削弱：
- 行为：输出、返回值或可观察的副作用
- 输入验证：公共 API 表面的任何检查
- 错误处理：失败如何被暴露和恢复
- 安全性：认证、访问控制、注入防御、密钥处理
- 可访问性：ARIA 语义、键盘导航、屏幕阅读器契约
- 性能：热路径延迟、紧循环中的内存分配

如果某个精简可能影响上述任何一项，跳过它并用 \`[thermo]\` 标记该发现，不给出精简建议。
`.trim();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build the thermo-nuclear profile directive for injection into dimension
 * and agent prompts.
 *
 * Returns `""` for the `"default"` profile to preserve byte-identity of all
 * existing prompts. Returns the full bilingual rubric for `"thermo-nuclear"`.
 */
export const buildProfileDirective = (
  profile: ReviewProfile,
  lang: "zh" | "en",
): string => {
  if (profile !== "thermo-nuclear") return "";
  return lang === "zh" ? THERMO_RUBRIC_ZH : THERMO_RUBRIC_EN;
};
