// Test file for auto-review - contains intentional issues
function getUser(id) {
  const query = "SELECT * FROM users WHERE id = " + id
  return query
}

function processData(data: any) {
  const result = data.map(item => item.value)
  return result
}

export { getUser, processData }
