// ============================================================================
// Authenticates opponent user from socket data
// ============================================================================
function normalizeRequestData(data) {
  let payload = data;

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      return null;
    }
  }

  if (Array.isArray(payload)) {
    payload = payload[0];
  }

  if (payload && typeof payload === 'object') {
    if (payload.data && typeof payload.data === 'object') {
      payload = payload.data;
    } else if (payload.payload && typeof payload.payload === 'object') {
      payload = payload.payload;
    }
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return payload;
}

async function authenticateOpponent(socket, data, eventName, decryptUserData) {
  const payload = normalizeRequestData(data);

  if (!payload) {
    socket.emit(eventName, {
      status: 'error',
      error_code: 'missing_field',
      error_type: 'field',
      field: 'request_data',
      message: 'No data provided',
    });
    return null;
  }

  const { user_data, jwt_token } = payload;

  if (user_data && jwt_token && typeof decryptUserData === 'function') {
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

  const hasUserId = payload.user_id || (socket.user && socket.user.user_id);

  if (hasUserId) {
    const mergedData = {
      ...payload,
      user_id: payload.user_id || socket.user.user_id,
      jwt_token: payload.jwt_token || jwt_token,
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
