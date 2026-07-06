# Plan Index

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 001 | Surface git and auto-review failures | P0 | S | - | DONE |
| 002 | Remove shell-assembled branch diff commands | P0 | M | - | SUPERSEDED by 013 |
| 003 | Align plugin dependency and lockfile state | P1 | S | - | DONE |
| 004 | Add reproducible verification scripts and CI gates | P0 | S | - | SUPERSEDED by 017 |
| 005 | Add minimal test coverage | P1 | M | 004 | DONE |
| 006 | Split agent prompt modules | P1 | M | 005 | DONE |
| 007 | Load markdown review rules from review-rules/ | P1 | M | 006 | DONE |
| 008 | Surface malformed review.json instead of silently falling back | P1 | S | - | DONE |
| 009 | Accept CRLF rule frontmatter | P2 | S | 007 | DONE |
| 010 | Retry auto-review after a failed prompt | P1 | S | 001 | DONE |
| 011 | Fix production-readiness blockers | P0 | M | 001,004,005,006 | DONE |
| 012 | Propagate git failures instead of empty diffs | P0 | S | - | DONE |
| 013 | Remove bash -c from review tool | P0 | M | 012 | DONE |
| 014 | Set auto-review cooldown after session validation | P0 | S | - | DONE |
| 015 | Thread file_rules into parallel sub-agents | P0 | S | - | DONE |
| 016 | Make custom_rules and max_diff_lines real | P0 | M | 015 | DONE |
| 017 | Enforce CI release gate | P0 | S | 012,013,014,015,016 | DONE |
| 018 | Surface malformed config in ocr status | P1 | S | - | DONE |
| 019 | Reconcile stale plan statuses | P1 | S | 012,013,017 | DONE |

Notes:
- 002 is superseded by 013 (DONE): the shell-assembled branch diff was replaced with native git invocation.
- 004 is superseded by 017 (DONE): the CI release gate workflow now exists.
- 010 remains valid for the failure-retry path, but 014 (DONE) covered a separate missing-ID cooldown bug.
