// ============================================================================
// Response Guarantee Utility
// Ensures users always get a response even if operations fail
// ============================================================================

const emitError = require('./emitError');

// ============================================================================
// Events that should not use response guarantees (too frequent or lightweight)
// ============================================================================
const SKIP_RESPONSE_GUARANTEE_EVENTS = [
  'heartbeat',
  'ping',
  'pong',
  'heartbeat:response',
  'keepalive',
  'keepalive:response',
  'server:heartbeat',
  'client:heartbeat:response'
];

// ============================================================================
// Creates a response guarantee wrapper for socket handlers
// ============================================================================
function createResponseGuarantee(socket, eventName, timeoutMs = 10000) {
  // Skip response guarantee for frequent/lightweight events
  if (SKIP_RESPONSE_GUARANTEE_EVENTS.includes(eventName)) {
    return {
      sendResponse: () => false,
      sendError: () => false,
      cleanup: () => {},
      isResponseSent: () => true,
      markAsSent: () => {}
    };
  }

  let responseSent = false;
  let timeoutId = null;

  const sendResponse = (data) => {
    if (responseSent) {
      // Response already sent, don't send again
      return false;
    }
    if (socket && socket.connected) {
      try {
        responseSent = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        socket.emit(eventName, data);
        return true;
      } catch (err) {
        // Socket might be disconnected, but we tried
        responseSent = false; // Reset so timeout can handle it
        return false;
      }
    }
    return false;
  };

  const sendError = (errorConfig) => {
    if (!responseSent && socket && socket.connected) {
      try {
        responseSent = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        emitError(socket, {
          code: errorConfig.code || 'operation_failed',
          type: errorConfig.type || 'system',
          field: errorConfig.field,
          message: errorConfig.message || 'An error occurred',
          event: errorConfig.event || eventName,
          status: errorConfig.status || 'error'
        });
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  };

  // Set timeout to guarantee response
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      if (!responseSent && socket && socket.connected) {
        sendError({
          code: 'timeout',
          type: 'system',
          message: 'Operation timed out. Please try again.',
          event: eventName
        });
      }
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return {
    sendResponse,
    sendError,
    cleanup,
    isResponseSent: () => responseSent,
    markAsSent: () => {
      responseSent = true;
      cleanup();
    }
  };
}

// ============================================================================
// Wraps an async handler function with response guarantee
// ============================================================================
function withResponseGuarantee(socket, eventName, handlerFn, timeoutMs = 10000) {
  return async (...args) => {
    const guarantee = createResponseGuarantee(socket, eventName, timeoutMs);
    
    try {
      const result = await handlerFn(...args, guarantee);
      
      // If handler didn't send response, send success response
      if (!guarantee.isResponseSent() && result !== undefined) {
        guarantee.sendResponse(result);
      }
      
      return result;
    } catch (err) {
      // Ensure error response is sent
      if (!guarantee.isResponseSent()) {
        guarantee.sendError({
          code: 'handler_error',
          type: 'system',
          message: err.message || 'An unexpected error occurred',
          event: eventName
        });
      }
      throw err;
    } finally {
      guarantee.cleanup();
    }
  };
}

module.exports = {
  createResponseGuarantee,
  withResponseGuarantee
};

