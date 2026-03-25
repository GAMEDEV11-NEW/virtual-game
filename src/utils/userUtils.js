const emitError = require('./emitError');

// ============================================================================
// Validates user by mobile number and user ID
// ============================================================================
function validateUserByMobile(user, user_id, socket, eventName) {
  if (!user) {
    emitError(socket, {
      code: 'auth_failed',
      type: 'authentication',
      field: 'jwt_token',
      message: 'User not found for token mobile number',
      event: eventName,
    });
    return false;
  }
  if (user.id !== user_id) {
    emitError(socket, {
      code: 'auth_failed',
      type: 'authentication',
      field: 'user_id',
      message: 'Token user does not match request user_id',
      event: eventName,
    });
    return false;
  }
  return true;
}

// ============================================================================
// Parses join month and joined_at date from string
// ============================================================================
function parseJoinMonth(joined_at, socket, eventName) {
  let joinMonth = new Date().toISOString().slice(0, 7);
  let joinedAt = null;
  if (joined_at) {
    try {
      const t = new Date(joined_at);
      if (!isNaN(t)) {
        joinMonth = t.toISOString().slice(0, 7);
        joinedAt = t.toISOString();
      }
    } catch (e) {
      emitError(socket, {
        code: 'invalid_format',
        type: 'format',
        field: 'joined_at',
        message: 'Failed to parse joined_at',
        event: eventName,
      });
      return null;
    }
  }
  return { joinMonth, joinedAt };
}

module.exports = {
  validateUserByMobile,
  parseJoinMonth
};
