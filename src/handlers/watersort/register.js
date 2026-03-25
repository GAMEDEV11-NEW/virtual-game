const { registerMatchInitHandler } = require('./matchInitHandler');
const { registerShootHandler } = require('./shootHandler');
const { registerQuitGameHandler } = require('./quitGameHandler');

const waterSortHandlers = [
  registerMatchInitHandler,
  registerShootHandler,
  registerQuitGameHandler,
];

function registerWaterSortHandlers(io, socket) {
  waterSortHandlers.forEach((registerHandler) => registerHandler(io, socket));
}

module.exports = registerWaterSortHandlers;

