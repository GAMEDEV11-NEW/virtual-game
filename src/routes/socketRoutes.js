// Ludo handlers
const registerLudoHandlers = require('../handlers/ludo/register');
const { registerDisconnectHandler: registerLudoDisconnect } = require('../handlers/ludo/disconnectHandler');

// Snakes & Ladders handlers
const registerSnakesLaddersHandlers = require('../handlers/snakesladders/register');
const registerSLTimer = require('../handlers/snakesladders/timerUpdateHandler');
const { registerDisconnectHandler: registerSLDisconnect } = require('../handlers/snakesladders/disconnectHandler');

// Tic-Tac-Toe handlers
const registerTicTacToeHandlers = require('../handlers/tictactoe/register');
const registerTTTTimer = require('../handlers/tictactoe/timerUpdateHandler');
const { registerDisconnectHandler: registerTTTDisconnect } = require('../handlers/tictactoe/disconnectHandler');

// Water Sort handlers
const registerWaterSortHandlers = require('../handlers/watersort/register');
const registerWSORTimer = require('../handlers/watersort/timerUpdateHandler');
const { registerDisconnectHandler: registerWSORTDisconnect } = require('../handlers/watersort/disconnectHandler');

// Common handlers
const { registerHeartbeatHandler } = require('../handlers/common/heartbeatHandler');

module.exports = function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    const timestamp = new Date().toISOString();
    
    // Send immediate response when client connects
    socket.emit('connection:established', {
      status: 'success',
      message: 'Connection established successfully!',
      socketId: socket.id,
      timestamp: timestamp,
      serverInfo: {
        uptime: process.uptime(),
        version: '1.0.0'
      }
    });
    
    // Register heartbeat handler first (handles frequent emits)
    registerHeartbeatHandler(io, socket);
    
    // Register different handler groups
    registerLudoHandlers(io, socket);

    // Snakes and Ladders game handlers
    registerSnakesLaddersHandlers(io, socket);
    const snakesLaddersTimerHandler = registerSLTimer(io, socket);

    // TIC TAC TOE GAME HANDLERS
    registerTicTacToeHandlers(io, socket);
    const ticTacToeTimerHandler = registerTTTTimer(io, socket);

    // WATER SORT PUZZLE HANDLERS
    registerWaterSortHandlers(io, socket);
    const waterSortTimerHandler = registerWSORTimer(io, socket);
    
    // Store timer handler references for cleanup
    socket.snakesLaddersTimerHandler = snakesLaddersTimerHandler;
    socket.ticTacToeTimerHandler = ticTacToeTimerHandler;
    socket.waterSortTimerHandler = waterSortTimerHandler;
    
    // Register disconnect handler with find opponent cancellation logic
    registerLudoDisconnect(io, socket);
    registerSLDisconnect(io, socket);
    registerTTTDisconnect(io, socket);
    registerWSORTDisconnect(io, socket);

    socket.on('disconnect', () => {
      // domain-specific cleanup handled in disconnect handler
    });
  });
};
 
