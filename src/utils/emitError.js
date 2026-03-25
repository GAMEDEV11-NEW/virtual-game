// ============================================================================
// Emits a standardized error response to the client via socket
// ============================================================================
function emitError(socket, errorConfig) {
  if (!socket || !socket.emit) {
    return;
  }

  const {
    code = 'unknown_error',
    type = 'error',
    field = null,
    message = 'An error occurred',
    event = 'error',
    status = null
  } = errorConfig;

  const errorResponse = {
    success: false,
    error: {
      code,
      type,
      message,
      timestamp: new Date().toISOString()
    }
  };

  if (field) {
    errorResponse.error.field = field;
  }

  // When verification_error occurs, include status with error details
  if (code === 'verification_error' && status !== null && status !== undefined) {
    errorResponse.status = String(status);
  }

  // For opponent:response event, always include status: 'error'
  if (event === 'opponent:response') {
    errorResponse.status = 'error';
  }

  // For quit game response events, always include status: 'error'
  const quitGameResponseEvents = [
    'quit:game:response',
    'snakesladders_quit_game_response',
    'tictactoe_quit_game_response',
    'watersort:quit:game:response'
  ];
  if (quitGameResponseEvents.includes(event)) {
    errorResponse.status = 'error';
  }

  socket.emit(event, errorResponse);
}

module.exports = emitError;
