// ============================================================================
// Authenticates opponent user from socket data
// ============================================================================
async function authenticateOpponent(socket, data, eventName, decryptUserData) {
  if (!data || typeof data !== 'object') {
    socket.emit(eventName, {
      status: 'error',
      error_code: 'missing_field',
      error_type: 'field',
      field: 'request_data',
      message: 'No data provided',
    });
    return null;
  }

  const { user_data, jwt_token } = data;

  if (user_data && jwt_token) {
    try {
      const decrypted = decryptUserData(user_data, jwt_token);

      if (!decrypted.jwt_token && jwt_token) {
        decrypted.jwt_token = jwt_token;
      }
      return decrypted;
    } catch (err) {
      socket.emit(eventName, {
        status: 'error',
        error_code: 'auth_failed',
        error_type: 'authentication',
        field: 'user_data',
        message: `Failed to decrypt user_data: ${err.message}`,
      });
      return null;
    }
  }

  const hasUserId = data.user_id || (socket.user && socket.user.user_id);

  if (hasUserId) {
    const mergedData = {
      ...data,
      user_id: data.user_id || socket.user.user_id,
      jwt_token: data.jwt_token || jwt_token,
    };

    return mergedData;
  }

  socket.emit(eventName, {
    status: 'error',
    error_code: 'auth_failed',
    error_type: 'authentication',
    field: 'user_data',
    message: 'Authentication required: provide either (user_data + jwt_token) or (user_id + jwt_token)',
  });
  return null;
}

module.exports = { authenticateOpponent };
