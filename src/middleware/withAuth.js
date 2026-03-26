const emitError = require('../utils/emitError');
const { authenticateOpponent } = require('../utils/authUtils');

// ============================================================================
// Middleware-like utility for authenticating socket events
// ============================================================================
async function withAuth(socket, event, responseEvent, handlerFn) {
  try {
    // Direct mode: do not decrypt user_data. Accept plain payload + socket user context.
    const decryptedData = await authenticateOpponent(socket, event, responseEvent);
    
    if (!decryptedData || !decryptedData.user_id) {
      throw new Error('Authentication failed');
    }
    
    await handlerFn(decryptedData, decryptedData);
  } catch (err) {
    emitError(socket, {
      code: 'auth_failed',
      type: 'authentication',
      field: 'jwt_token',
      message: `User authentication failed: ${err.message}`,
      event: responseEvent,
    });
  }
}

module.exports = withAuth;
