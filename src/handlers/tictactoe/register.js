const { registerCheckOpponentHandler } = require('./checkOpponentHandler');
const { registerMakeMoveHandler } = require('./makeMoveHandler');
const { registerQuitGameHandler } = require('./quitGameHandler');

const ticTacToeGameHandlers = [
  registerCheckOpponentHandler,
  registerMakeMoveHandler,
  registerQuitGameHandler,
];

function registerTicTacToeHandlers(io, socket) {
  ticTacToeGameHandlers.forEach((registerHandler) => registerHandler(io, socket));
}

module.exports = registerTicTacToeHandlers;
