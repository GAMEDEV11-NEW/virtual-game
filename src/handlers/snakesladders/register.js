const { registerDiceRollHandler } = require('./diceRollHandler');
const { registerPieceMoveHandler } = require('./pieceMoveHandler');
const { registerQuitGameHandler } = require('./quitGameHandler');
const snakesLaddersGameHandlers = [
  registerDiceRollHandler,
  registerPieceMoveHandler,
  registerQuitGameHandler
];

function registerSnakesLaddersHandlers(io, socket) {
  snakesLaddersGameHandlers.forEach((registerHandler) => registerHandler(io, socket));
}

module.exports = registerSnakesLaddersHandlers;
