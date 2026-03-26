const { processWinnerDeclaration } = require('../../services/ludo/windeclearService');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const {
  getAndValidateGameMatch: baseGetAndValidateGameMatch,
  updateGameStateInRedis: baseUpdateGameStateInRedis,
  notifyOpponent: baseNotifyOpponent,
  sendQuitResponse: baseSendQuitResponse
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
    message: 'You won! Your opponent has quit the game'
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
    message: 'Game quit successfully. Your opponent won the game.'
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

      const opponentId = match.user1_id === user_id ? match.user2_id : match.user1_id;
      const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'ludo');

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
        quitAt: new Date().toISOString()
      };

      notifyOpponent(io, opponentSocketId, gameData);
      sendQuitResponse(socket, gameData);
    } catch (error) {
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
