const { registerCheckOpponentHandler } = require('./checkOpponentHandler');
const { registerDiceRollHandler } = require('./diceRollHandler');
const { registerPieceMoveHandler } = require('./pieceMoveHandler');
const { registerQuitGameHandler } = require('./quitGameHandler');

const gameHandlers = [
  registerCheckOpponentHandler,
  registerDiceRollHandler,
  registerPieceMoveHandler,
  registerQuitGameHandler
];

// ============================================================================
// Register all handlers for a socket
// ============================================================================
function registerLudoHandlers(io, socket) {
  gameHandlers.forEach((registerHandler) => registerHandler(io, socket));
}

module.exports = registerLudoHandlers;
