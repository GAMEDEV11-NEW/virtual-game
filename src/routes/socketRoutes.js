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
const mysqlClient = require('../services/mysql/client');

const LUDO_FINISH_WATCH_INTERVAL_MS = Math.max(1000, Number(process.env.LUDO_FINISH_WATCH_INTERVAL_MS || 3000));

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toNumberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isCompletedStatus(status) {
  return normalize(status).toLowerCase() === 'completed';
}

async function fetchLatestLudoFinishRow(socket) {
  const userId = normalize(socket?.user?.user_id || socket?.handshake?.auth?.user_id || socket?.handshake?.query?.user_id);
  const contestId = normalize(socket?.user?.contest_id || socket?.handshake?.auth?.contest_id || socket?.handshake?.query?.contest_id);
  const lId = normalize(
    socket?.user?.l_id ||
    socket?.user?.contest_join_data?.l_id ||
    socket?.contestJoinData?.l_id ||
    socket?.handshake?.auth?.l_id ||
    socket?.handshake?.query?.l_id
  );
  if (!userId) return null;

  const selectSql = `
    SELECT match_id, status, winner_user_id, user_id, opponent_user_id, contest_id, ended_at, updated_at
    FROM ludo_game
    WHERE is_deleted = 0 AND l_id = ?
    ORDER BY updated_at DESC
    LIMIT 1`;
  if (lId) {
    const [rows] = await mysqlClient.query(selectSql, [lId]);
    if (Array.isArray(rows) && rows[0]) {
      return rows[0];
    }
  }

  if (contestId) {
    const [rows] = await mysqlClient.query(
      `SELECT match_id, status, winner_user_id, user_id, opponent_user_id, contest_id, ended_at, updated_at
       FROM ludo_game
       WHERE is_deleted = 0 AND user_id = ? AND contest_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId, contestId]
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  const [rows] = await mysqlClient.query(
    `SELECT match_id, status, winner_user_id, user_id, opponent_user_id, contest_id, ended_at, updated_at
     FROM ludo_game
     WHERE is_deleted = 0 AND user_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId]
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function emitLudoFinishIfNeeded(socket) {
  if (!socket?.connected) return;
  const row = await fetchLatestLudoFinishRow(socket);
  if (!row || !isCompletedStatus(row.status)) return;

  const userId = normalize(socket?.user?.user_id || socket?.handshake?.auth?.user_id || socket?.handshake?.query?.user_id);
  const winnerId = normalize(row.winner_user_id);
  if (!userId || !winnerId) return;

  const matchId = normalize(row.match_id);
  if (socket._ludoQuitEmitGuard instanceof Set && socket._ludoQuitEmitGuard.has(matchId)) {
    return;
  }
  const version = normalize(row.updated_at || row.ended_at || '');
  const dedupeKey = `${matchId}:${version}:${winnerId}`;
  if (socket._ludoFinishLastDedupeKey === dedupeKey) return;
  socket._ludoFinishLastDedupeKey = dedupeKey;

  const isWinner = userId === winnerId;
  const selfUsername = normalize(
    socket?.user?.username ||
    socket?.user?.contest_join_data?.username ||
    socket?.contestJoinData?.username ||
    ''
  );
  const user1Id = normalize(row.user_id);
  const opponentId = normalize(row.opponent_user_id);
  const scoreUser1 = toNumberOrZero(row.user1_score);
  const scoreUser2 = toNumberOrZero(row.user2_score);
  const winnerIsUser1 = winnerId && winnerId === user1Id;
  const winnerScore = winnerIsUser1 ? scoreUser1 : scoreUser2;
  const loserScore = winnerIsUser1 ? scoreUser2 : scoreUser1;
  const payload = {
    status: 'success',
    game_id: matchId,
    winner_id: winnerId,
    loser_id: isWinner ? opponentId : userId,
    winner_score: winnerScore,
    loser_score: loserScore,
    user_score: isWinner ? winnerScore : loserScore,
    opponent_score: isWinner ? loserScore : winnerScore,
    completed_at: normalize(row.ended_at || row.updated_at || new Date().toISOString()),
    game_end_reason: 'game_completed',
    timestamp: new Date().toISOString(),
    user_username: selfUsername
  };
  const eventName = isWinner ? 'game:won' : 'game:lost';
  socket.emit(eventName, payload);
}

function startLudoFinishObserver(socket) {
  if (socket._ludoFinishWatcherInterval) {
    clearInterval(socket._ludoFinishWatcherInterval);
    socket._ludoFinishWatcherInterval = null;
  }

  const runCheck = async () => {
    try {
      await emitLudoFinishIfNeeded(socket);
    } catch (_) {
    }
  };

  runCheck().catch(() => {});
  socket._ludoFinishWatcherInterval = setInterval(() => {
    runCheck().catch(() => {});
  }, LUDO_FINISH_WATCH_INTERVAL_MS);
}

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

    // 1) Immediate connect/reconnect finish check.
    // 2) Continuous observer while connected.
    startLudoFinishObserver(socket);

    socket.on('disconnect', () => {
      // domain-specific cleanup handled in disconnect handler
    });
  });
};
 
