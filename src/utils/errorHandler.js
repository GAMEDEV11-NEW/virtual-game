const emitError = require('./emitError');

const ERROR_TYPES = {
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  DATA: 'data',
  DATABASE: 'database',
  REDIS: 'redis',
  SYSTEM: 'system',
  NETWORK: 'network',
  TIMEOUT: 'timeout'
};

const ERROR_CODES = {
  MISSING_FIELD: 'missing_field',
  INVALID_FIELD: 'invalid_field',
  NOT_FOUND: 'not_found',
  AUTH_FAILED: 'auth_failed',
  INVALID_TOKEN: 'invalid_token',
  UNAUTHORIZED: 'unauthorized',
  PARSE_ERROR: 'parse_error',
  REDIS_ERROR: 'redis_error',
  DB_ERROR: 'db_error',
  INTERNAL_ERROR: 'internal_error',
  TIMEOUT_ERROR: 'timeout_error',
  VERIFICATION_ERROR: 'verification_error'
};

// ============================================================================
// Safely execute an async function, catching and handling errors
// ============================================================================
async function safeExecute(fn, options = {}) {
  const {
    socket = null,
    eventName = 'error',
    errorCode = ERROR_CODES.INTERNAL_ERROR,
    errorType = ERROR_TYPES.SYSTEM,
    errorMessage = 'An error occurred',
    onError = null,
    defaultValue = null
  } = options;

  try {
    return await fn();
  } catch (error) {
    if (onError && typeof onError === 'function') {
      return onError(error);
    }

    if (socket) {
      emitError(socket, {
        code: errorCode,
        type: errorType,
        message: errorMessage || (error.message || 'An error occurred'),
        event: eventName
      });
    }

    return defaultValue;
  }
}

// ============================================================================
// Safely execute multiple async operations, continuing even if some fail
// ============================================================================
async function safeExecuteAll(operations, options = {}) {
  const { continueOnError = true } = options;
  const results = [];

  for (const operation of operations) {
    try {
      const result = await operation();
      results.push({ success: true, result });
    } catch (error) {
      results.push({ success: false, error: error.message || 'Unknown error' });
      if (!continueOnError) {
        throw error;
      }
    }
  }

  return results;
}

// ============================================================================
// Create error response object
// ============================================================================
function createErrorResponse(code, type, message, field = null) {
  const error = {
    code,
    type,
    message,
    timestamp: new Date().toISOString()
  };

  if (field) {
    error.field = field;
  }

  return {
    success: false,
    error
  };
}

// ============================================================================
// Validate and handle database errors
// ============================================================================
function handleDatabaseError(error, socket, eventName) {
  if (!error) return false;

  const errorMessage = error.message || 'Database operation failed';

  emitError(socket, {
    code: ERROR_CODES.DB_ERROR,
    type: ERROR_TYPES.DATABASE,
    message: errorMessage,
    event: eventName
  });

  return true;
}

// ============================================================================
// Validate and handle Redis errors
// ============================================================================
function handleRedisError(error, socket, eventName) {
  if (!error) return false;

  const errorMessage = error.message || 'Redis operation failed';

  emitError(socket, {
    code: ERROR_CODES.REDIS_ERROR,
    type: ERROR_TYPES.REDIS,
    message: errorMessage,
    event: eventName
  });

  return true;
}

module.exports = {
  ERROR_TYPES,
  ERROR_CODES,
  safeExecute,
  safeExecuteAll,
  createErrorResponse,
  handleDatabaseError,
  handleRedisError
};
