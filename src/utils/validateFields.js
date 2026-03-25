const emitError = require('./emitError');

// ============================================================================
// Validates required fields in data object
// ============================================================================
function validateFields(socket, data, requiredFields, event = 'validation_error') {
  let allPresent = true;
  for (const field of requiredFields) {
    if (!data[field]) {
      emitError(socket, {
        code: 'missing_field',
        type: 'validation',
        field,
        message: `${field} is required`,
        event
      });
      allPresent = false;
    }
  }
  return allPresent;
}

module.exports = validateFields;
