const ludoModule = require('./ludo');
const snakesModule = require('./snakes');
const tictactoeModule = require('./tictactoe');
const watersortModule = require('./watersort');

module.exports = {
  setLudoMatchmakingService: ludoModule.setLudoMatchmakingService,
  startLudoUserTimerCron: ludoModule.startLudoUserTimerCron,
  stopLudoUserTimerCron: ludoModule.stopLudoUserTimerCron,
  
  setSnakesMatchmakingService: snakesModule.setSnakesMatchmakingService,
  startSnakesLaddersUserTimerCron: snakesModule.startSnakesLaddersUserTimerCron,
  stopSnakesLaddersUserTimerCron: snakesModule.stopSnakesLaddersUserTimerCron,
  
  setTicTacToeMatchmakingService: tictactoeModule.setTicTacToeMatchmakingService,
  startTicTacToeUserTimerCron: tictactoeModule.startTicTacToeUserTimerCron,
  stopTicTacToeUserTimerCron: tictactoeModule.stopTicTacToeUserTimerCron,
  
  setMatchmakingService: watersortModule.setMatchmakingService,
  startWaterSortUserTimerCron: watersortModule.startWaterSortUserTimerCron,
  stopWaterSortUserTimerCron: watersortModule.stopWaterSortUserTimerCron,
  
  setSocketIO: (io) => {
    ludoModule.setSocketIO(io);
    snakesModule.setSocketIO(io);
    tictactoeModule.setSocketIO(io);
    watersortModule.setSocketIO(io);
  }
};
