// ============================================================================
// Cron job service
// ============================================================================

const mysqlClient = require('../services/mysql/client');
const { TIMER_CONSTANTS } = require('../constants');
const {
  getLudoLeagueIds,
  getSnakesLeagueIds,
  getTicTacToeLeagueIds,
  getWaterSortLeagueIds
} = require('./config');

const timerModule = require('./timers');

let ludoMatchmakingService = null;
let ludoMatchmakingTimerId = null;
let ludoUserTimerStarted = false;
let ludoSettlementService = null;
let ludoSettlementTimerId = null;

let snakesMatchmakingService = null;
let snakesMatchmakingTimerId = null;
let snakesUserTimerStarted = false;

let tictactoeMatchmakingService = null;
let tictactoeMatchmakingTimerId = null;
let tictactoeUserTimerStarted = false;

let watersortMatchmakingService = null;
let watersortMatchmakingTimerId = null;
let watersortUserTimerStarted = false;

let isRunning = false;
let mysqlSession = null;

function toCsv(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

function startLudoMatchmaking(session) {
  if (ludoMatchmakingTimerId) {
    return;
  }

  const ludoLeagueIds = getLudoLeagueIds();
  const ludoLeagueIdsCsv = toCsv(ludoLeagueIds);
  const ludoMatchmakingInterval = TIMER_CONSTANTS.MATCHMAKING_TICK;

  const { LudoMatchmakingService } = require('./matchmaking/ludo');
  ludoMatchmakingService = new LudoMatchmakingService(session);

  timerModule.setLudoMatchmakingService(ludoMatchmakingService);

  ludoMatchmakingTimerId = setInterval(() => {
    ludoMatchmakingService.processMatchmakingForLeagues(ludoLeagueIdsCsv).catch(() => {});
  }, ludoMatchmakingInterval);

  console.log(`[Cron] Ludo matchmaking started (tick=${ludoMatchmakingInterval}ms, leagues=${ludoLeagueIdsCsv})`);
}

function stopLudoMatchmaking() {
  if (ludoMatchmakingTimerId) {
    clearInterval(ludoMatchmakingTimerId);
    ludoMatchmakingTimerId = null;
  }
}

function startLudoUserTimers() {
  if (ludoUserTimerStarted) {
    return;
  }

  const ludoUserTimerInterval = TIMER_CONSTANTS.USER_TIMER_TICK;
  timerModule.startLudoUserTimerCron(ludoUserTimerInterval);
  ludoUserTimerStarted = true;
  console.log(`[Cron] Ludo user timer started (tick=${ludoUserTimerInterval}ms)`);
}

function startLudoSettlement(session) {
  if (ludoSettlementTimerId) {
    return;
  }

  const intervalMs = Number(process.env.LUDO_STALE_SETTLE_TICK_MS || 60000);
  const { LudoSettlementService } = require('./services/ludoSettlementService');
  ludoSettlementService = new LudoSettlementService(session);

  ludoSettlementTimerId = setInterval(() => {
    ludoSettlementService.processStaleEntries().catch(() => {});
  }, intervalMs);
  console.log(`[Cron] Ludo settlement started (tick=${intervalMs}ms)`);
}

function stopLudoUserTimers() {
  if (!ludoUserTimerStarted) {
    return;
  }

  timerModule.stopLudoUserTimerCron();
  ludoUserTimerStarted = false;
}

function stopLudoSettlement() {
  if (ludoSettlementTimerId) {
    clearInterval(ludoSettlementTimerId);
    ludoSettlementTimerId = null;
  }
  ludoSettlementService = null;
}

// ============================================================================
// Snakes & Ladders
// ============================================================================

function startSnakesMatchmaking(session) {
  if (snakesMatchmakingTimerId) {
    return;
  }

  const snakesLeagueIds = getSnakesLeagueIds();
  const snakesLeagueIdsCsv = toCsv(snakesLeagueIds);
  const snakesMatchmakingInterval = TIMER_CONSTANTS.MATCHMAKING_TICK;

  const { SnakesMatchmakingService } = require('./matchmaking/snakes');
  snakesMatchmakingService = new SnakesMatchmakingService(session);

  timerModule.setSnakesMatchmakingService(snakesMatchmakingService);

  snakesMatchmakingTimerId = setInterval(() => {
    snakesMatchmakingService.processSnakesLaddersMatchmaking(snakesLeagueIdsCsv).catch(() => {});
  }, snakesMatchmakingInterval);
}

function stopSnakesMatchmaking() {
  if (snakesMatchmakingTimerId) {
    clearInterval(snakesMatchmakingTimerId);
    snakesMatchmakingTimerId = null;
  }
}

function startSnakesUserTimers() {
  if (snakesUserTimerStarted) {
    return;
  }

  const snakesUserTimerInterval = TIMER_CONSTANTS.USER_TIMER_TICK;
  timerModule.startSnakesLaddersUserTimerCron(snakesUserTimerInterval);
  snakesUserTimerStarted = true;
}

function stopSnakesUserTimers() {
  if (!snakesUserTimerStarted) {
    return;
  }

  timerModule.stopSnakesLaddersUserTimerCron();
  snakesUserTimerStarted = false;
}

// ============================================================================
// TicTacToe
// ============================================================================

function startTicTacToeMatchmaking(session) {
  if (tictactoeMatchmakingTimerId) {
    return;
  }

  const tictactoeLeagueIds = getTicTacToeLeagueIds();
  const tictactoeLeagueIdsCsv = toCsv(tictactoeLeagueIds);
  const tictactoeMatchmakingInterval = TIMER_CONSTANTS.MATCHMAKING_TICK;

  const { TicTacToeMatchmakingService } = require('./matchmaking/tictactoe');
  tictactoeMatchmakingService = new TicTacToeMatchmakingService(session);

  timerModule.setTicTacToeMatchmakingService(tictactoeMatchmakingService);

  tictactoeMatchmakingTimerId = setInterval(() => {
    tictactoeMatchmakingService.processTicTacToeMatchmaking(tictactoeLeagueIdsCsv).catch(() => {});
  }, tictactoeMatchmakingInterval);
}

function stopTicTacToeMatchmaking() {
  if (tictactoeMatchmakingTimerId) {
    clearInterval(tictactoeMatchmakingTimerId);
    tictactoeMatchmakingTimerId = null;
  }
}

function startTicTacToeUserTimers() {
  if (tictactoeUserTimerStarted) {
    return;
  }

  const tictactoeUserTimerInterval = TIMER_CONSTANTS.USER_TIMER_TICK;
  timerModule.startTicTacToeUserTimerCron(tictactoeUserTimerInterval);

  tictactoeUserTimerStarted = true;
}

function stopTicTacToeUserTimers() {
  if (!tictactoeUserTimerStarted) {
    return;
  }

  timerModule.stopTicTacToeUserTimerCron();
  tictactoeUserTimerStarted = false;
}

// ============================================================================
// WaterSort
// ============================================================================

function startWaterSortMatchmaking(session) {
  if (watersortMatchmakingTimerId) {
    return;
  }

  const watersortLeagueIds = getWaterSortLeagueIds();
  const watersortLeagueIdsCsv = toCsv(watersortLeagueIds);
  const watersortMatchmakingInterval = TIMER_CONSTANTS.MATCHMAKING_TICK;

  const { WaterSortMatchmakingService } = require('./matchmaking/watersort');
  watersortMatchmakingService = new WaterSortMatchmakingService(session);

  timerModule.setMatchmakingService(watersortMatchmakingService);

  watersortMatchmakingTimerId = setInterval(() => {
    watersortMatchmakingService.processWaterSortMatchmaking(watersortLeagueIdsCsv).catch(() => {});
  }, watersortMatchmakingInterval);
}

function stopWaterSortMatchmaking() {
  if (watersortMatchmakingTimerId) {
    clearInterval(watersortMatchmakingTimerId);
    watersortMatchmakingTimerId = null;
  }
}

function startWaterSortUserTimers() {
  if (watersortUserTimerStarted) {
    return;
  }

  const watersortUserTimerInterval = TIMER_CONSTANTS.USER_TIMER_TICK;
  timerModule.startWaterSortUserTimerCron(watersortUserTimerInterval);
  watersortUserTimerStarted = true;
}

function stopWaterSortUserTimers() {
  if (!watersortUserTimerStarted) {
    return;
  }

  timerModule.stopWaterSortUserTimerCron();
  watersortUserTimerStarted = false;
}

// ============================================================================
// Main Functions
// ============================================================================

async function initializeCronService(io = null) {
  if (isRunning) {
    return;
  }
  mysqlSession = await mysqlClient;

  startLudoMatchmaking(mysqlSession);
  startLudoUserTimers();
  startLudoSettlement(mysqlSession);

  isRunning = true;
  console.log('[Cron] initializeCronService completed');
}

function stopCronService() {
  if (!isRunning) {
    return;
  }

  stopLudoMatchmaking();
  stopLudoUserTimers();
  stopLudoSettlement();

  isRunning = false;
  mysqlSession = null;
}

// ============================================================================
// Shutdown Handlers
// ============================================================================

process.on('SIGINT', () => {
  stopCronService();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopCronService();
  process.exit(0);
});

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  initializeCronService,
  stopCronService
};
