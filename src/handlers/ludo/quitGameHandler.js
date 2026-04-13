const { processWinnerDeclaration } = require('../../services/ludo/windeclearService');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const {
  getAndValidateGameMatch: baseGetAndValidateGameMatch,
  updateGameStateInRedis: baseUpdateGameStateInRedis,
  updateDatabaseRecords: baseUpdateDatabaseRecords,
  notifyOpponent: baseNotifyOpponent,
  sendQuitResponse: baseSendQuitResponse,
  stopTimers: baseStopTimers,
  cleanupRedisKeys: baseCleanupRedisKeys
} = require('../common/baseHandlers');
const {
  GAME_STATUS,
  GAME_END_REASONS,
  REDIS_KEYS
} = require('../../constants');
const { timerRegistry, timerEventBus } = require('../../utils/timer');

const QUIT_GAME_EVENTS = {
  REQUEST: 'quit:game',
  RESPONSE: 'quit:game:response',
  NOTIFICATION: 'game:quit:notification'
};

function stringifyProfile(profile = {}) {
  const username = String(profile?.username || '').trim();
  const image = String(profile?.image || '').trim();
  const email = String(profile?.email || '').trim();
  if (!username && !image && !email) return '';
  return JSON.stringify({ username, image, email });
}

function markQuitEmitGuard(targetSocket, gameId) {
  if (!targetSocket || !gameId) return;
  if (!targetSocket._ludoQuitEmitGuard || !(targetSocket._ludoQuitEmitGuard instanceof Set)) {
    targetSocket._ludoQuitEmitGuard = new Set();
  }
  targetSocket._ludoQuitEmitGuard.add(String(gameId));
}

function toScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num;
}

const gameConfig = {
  getMatchKey: (gameId) => REDIS_KEYS.MATCH(gameId),
  emitError,
  responseEvent: QUIT_GAME_EVENTS.RESPONSE,
  processWinnerDeclaration,
  notificationEvent: QUIT_GAME_EVENTS.NOTIFICATION,
  timerStopEvent: 'stop:timer_updates',
  formatNotification: (gameData) => ({
    status: 'game_won',
    game_id: gameData.gameId,
    contest_id: gameData.contestId,
    winner_id: gameData.opponentId,
    quit_by: gameData.userId,
    quit_at: gameData.quitAt,
    completed_at: gameData.quitAt,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    message: 'You won! Your opponent has quit the game',
    user_full_name: gameData.opponentUsername || '',
    user_profile_data: stringifyProfile(gameData.opponentProfile || {}),
    opponent_full_name: gameData.userUsername || '',
    opponent_profile_data: stringifyProfile(gameData.userProfile || {}),
    user_username: gameData.opponentUsername || '',
    opponent_username: gameData.userUsername || ''
  }),
  formatResponse: (gameData) => ({
    status: 'game_lost',
    game_id: gameData.gameId,
    contest_id: gameData.contestId,
    user_id: gameData.userId,
    winner_id: gameData.opponentId,
    quit_at: gameData.quitAt,
    completed_at: gameData.quitAt,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    message: 'Game quit successfully. Your opponent won the game.',
    user_full_name: gameData.userUsername || '',
    user_profile_data: stringifyProfile(gameData.userProfile || {}),
    opponent_full_name: gameData.opponentUsername || '',
    opponent_profile_data: stringifyProfile(gameData.opponentProfile || {}),
    user_username: gameData.userUsername || '',
    opponent_username: gameData.opponentUsername || ''
  }),
  cleanupRedisMatchData: async (gameId) => {
    const { cleanupRedisMatchData } = require('../../services/ludo/windeclearService');
    return cleanupRedisMatchData(gameId);
  }
};

// ============================================================================
// Adapter wrappers for shared quit helpers
// ============================================================================
async function getAndValidateGameMatch(gameId, userId, socket) {
  return baseGetAndValidateGameMatch(gameId, userId, socket, gameConfig);
}

async function updateGameStateInRedis(match, userId, opponentId, gameId, socket) {
  return baseUpdateGameStateInRedis(match, userId, opponentId, gameId, socket, gameConfig);
}

function notifyOpponent(io, opponentSocketId, gameData) {
  baseNotifyOpponent(io, opponentSocketId, gameData, gameConfig);
}

function sendQuitResponse(socket, gameData) {
  baseSendQuitResponse(socket, gameData, gameConfig);
}

async function updateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket) {
  return baseUpdateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket, gameConfig);
}

function stopTimers(io, socket, opponentSocketId, gameId, opponentId, quitAt) {
  baseStopTimers(io, socket, opponentSocketId, gameId, opponentId, quitAt, gameConfig);
}

async function cleanupRedisKeys(gameId) {
  return baseCleanupRedisKeys(gameId, gameConfig);
}

// ============================================================================
// Register quit handler
// ============================================================================
async function registerQuitGameHandler(io, socket) {
  socket.removeAllListeners(QUIT_GAME_EVENTS.REQUEST);
  socket.on(QUIT_GAME_EVENTS.REQUEST, async (data) => {
    try {
      const payload = (data && typeof data === 'object') ? data : {};
      const directData = {
        ...payload,
        user_id: payload.user_id || socket?.user?.user_id || ''
      };
      const requiredFields = ['user_id', 'game_id', 'contest_id'];
      if (!validateFields(socket, directData, requiredFields, QUIT_GAME_EVENTS.RESPONSE)) {
        return;
      }

      const { user_id, game_id, contest_id } = directData;
      const match = await getAndValidateGameMatch(game_id, user_id, socket);
      if (!match) return;

      const normalizedUserId = String(user_id || '').trim();
      const matchUser1Id = String(match.user1_id || '').trim();
      const opponentId = matchUser1Id === normalizedUserId ? match.user2_id : match.user1_id;
      const normalizedOpponentId = String(opponentId || '').trim();
      const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'ludo');
      const safeOpponentSocketId = (
        opponentSocketId &&
        opponentSocketId !== socket.id &&
        normalizedOpponentId &&
        normalizedOpponentId !== normalizedUserId
      ) ? opponentSocketId : null;

      const updateSuccess = await updateGameStateInRedis(match, user_id, opponentId, game_id, socket);
      if (!updateSuccess) {
        const errorGameData = {
          gameId: game_id,
          contestId: contest_id,
          userId: user_id,
          opponentId,
          quitAt: new Date().toISOString()
        };
        sendQuitResponse(socket, errorGameData);
        return;
      }

      const gameData = {
        gameId: game_id,
        contestId: contest_id,
        userId: user_id,
        opponentId,
        quitAt: new Date().toISOString(),
        userScore: 0,
        opponentScore: 0,
        userUsername: String(socket?.user?.username || socket?.user?.contest_join_data?.username || '').trim(),
        userProfile: {
          username: String(socket?.user?.username || socket?.user?.contest_join_data?.username || '').trim(),
          image: String(socket?.user?.user_image || socket?.user?.contest_join_data?.user_image || '').trim(),
          email: String(socket?.user?.user_email || socket?.user?.contest_join_data?.user_email || '').trim()
        },
        opponentUsername: '',
        opponentProfile: {}
      };
      if (safeOpponentSocketId) {
        const opponentSocket = io.sockets.sockets.get(safeOpponentSocketId);
        gameData.opponentUsername = String(opponentSocket?.user?.username || opponentSocket?.user?.contest_join_data?.username || '').trim();
        gameData.opponentProfile = {
          username: gameData.opponentUsername,
          image: String(opponentSocket?.user?.user_image || opponentSocket?.user?.contest_join_data?.user_image || '').trim(),
          email: String(opponentSocket?.user?.user_email || opponentSocket?.user?.contest_join_data?.user_email || '').trim()
        };
      }
      const scoreMatchUser1Id = String(match?.user1_id || '').trim();
      const normalizedActorId = String(user_id || '').trim();
      const actorIsUser1 = normalizedActorId && normalizedActorId === scoreMatchUser1Id;
      const scoreUser1 = toScore(match?.user1_score);
      const scoreUser2 = toScore(match?.user2_score);
      gameData.userScore = actorIsUser1 ? scoreUser1 : scoreUser2;
      gameData.opponentScore = actorIsUser1 ? scoreUser2 : scoreUser1;

      await updateDatabaseRecords(game_id, opponentId, user_id, contest_id, match, socket);
      stopTimers(io, socket, safeOpponentSocketId, game_id, opponentId, gameData.quitAt);
      await cleanupRedisKeys(game_id);

      notifyOpponent(io, safeOpponentSocketId, gameData);
      sendQuitResponse(socket, gameData);
      try {
        const winnerPayload = {
          status: 'success',
          game_id: game_id,
          winner_id: opponentId,
          loser_id: user_id,
          completed_at: gameData.quitAt,
          game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
          timestamp: new Date().toISOString(),
          winner_username: gameData.opponentUsername || '',
          loser_username: gameData.userUsername || '',
          winner_profile_data: stringifyProfile(gameData.opponentProfile || {}),
          loser_profile_data: stringifyProfile(gameData.userProfile || {}),
          winner_score: toScore(gameData.opponentScore),
          loser_score: toScore(gameData.userScore),
          user_score: toScore(gameData.opponentScore),
          opponent_score: toScore(gameData.userScore)
        };
        const loserPayload = {
          status: 'success',
          game_id: game_id,
          winner_id: opponentId,
          loser_id: user_id,
          completed_at: gameData.quitAt,
          game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
          timestamp: new Date().toISOString(),
          winner_username: gameData.opponentUsername || '',
          loser_username: gameData.userUsername || '',
          winner_profile_data: stringifyProfile(gameData.opponentProfile || {}),
          loser_profile_data: stringifyProfile(gameData.userProfile || {}),
          winner_score: toScore(gameData.opponentScore),
          loser_score: toScore(gameData.userScore),
          user_score: toScore(gameData.userScore),
          opponent_score: toScore(gameData.opponentScore)
        };

        if (safeOpponentSocketId) {
          const opponentSocket = io.sockets.sockets.get(safeOpponentSocketId);
          markQuitEmitGuard(opponentSocket, game_id);
          io.to(safeOpponentSocketId).emit('game:won', winnerPayload);
        }

        markQuitEmitGuard(socket, game_id);
        socket.emit('game:lost', loserPayload);
      } catch (_) {
      }
    } catch (error) {
      void error;
      emitError(socket, {
        code: 'internal_error',
        type: 'system',
        field: 'handler',
        message: 'An unexpected error occurred while processing quit game request',
        event: QUIT_GAME_EVENTS.RESPONSE
      });
    }
  });
}

module.exports = { registerQuitGameHandler };
