const { authenticateOpponent } = require('../../utils/authUtils');
const { getUserByMobile } = require('../../services/ludo/gameService');
const { processWinnerDeclaration } = require('../../services/ludo/windeclearService');
const { validateJWTToken, validateJwtClaims, decryptUserData } = require('../../utils/jwt');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { validateUserByMobile } = require('../../utils/userUtils');
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
// Validate JWT token/claims
// ============================================================================
async function validateJwtTokenAndClaims(jwtToken, socket) {
  try {
    const jwtClaims = validateJWTToken(jwtToken);
    if (!jwtClaims) {
      throw new Error('Invalid JWT token');
    }

    if (!validateJwtClaims(jwtClaims, socket, QUIT_GAME_EVENTS.RESPONSE)) {
      return null;
    }

    return jwtClaims;
  } catch (error) {
    emitError(socket, {
      code: 'auth_failed',
      type: 'authentication',
      field: 'jwt_token',
      message: 'Invalid or expired token',
      event: QUIT_GAME_EVENTS.RESPONSE
    });
    return null;
  }
}

// ============================================================================
// Validate user identity before proceeding
// ============================================================================
async function validateUserAuthentication(decrypted, socket) {
  const jwtClaims = await validateJwtTokenAndClaims(decrypted.jwt_token, socket);
  if (!jwtClaims) return null;

  const user = await getUserByMobile(jwtClaims.mobile_no);
  if (!validateUserByMobile(user, decrypted.user_id, socket, QUIT_GAME_EVENTS.RESPONSE)) {
    return null;
  }

  return { user, jwtClaims };
}

// ============================================================================
// Adapter wrappers for shared quit helpers
// ============================================================================
async function getAndValidateGameMatch(gameId, userId, socket) {
  return baseGetAndValidateGameMatch(gameId, userId, socket, gameConfig);
}

async function updateGameStateInRedis(match, userId, opponentId, gameId, socket) {
  return baseUpdateGameStateInRedis(match, userId, opponentId, gameId, socket, gameConfig);
}

async function updateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket) {
  return baseUpdateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket, gameConfig);
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
  socket.on(QUIT_GAME_EVENTS.REQUEST, async (data) => {
    try {
      const decrypted = await authenticateOpponent(socket, data, QUIT_GAME_EVENTS.RESPONSE, decryptUserData);
      if (!decrypted) return;

      const requiredFields = ['user_id', 'game_id', 'contest_id'];
      if (!validateFields(socket, decrypted, requiredFields, QUIT_GAME_EVENTS.RESPONSE)) {
        return;
      }

      const authResult = await validateUserAuthentication(decrypted, socket);
      if (!authResult) return;

      const { user_id, game_id, contest_id } = decrypted;
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

      const dbUpdateSuccess = await updateDatabaseRecords(game_id, opponentId, user_id, contest_id, match, socket);

      const gameData = {
        gameId: game_id,
        contestId: contest_id,
        userId: user_id,
        opponentId,
        quitAt: new Date().toISOString()
      };

      notifyOpponent(io, opponentSocketId, gameData);
      sendQuitResponse(socket, gameData);

      if (!dbUpdateSuccess) {
      }

      baseStopTimers(io, socket, opponentSocketId, game_id, opponentId, gameData.quitAt, gameConfig);

      try {
        if (timerRegistry.hasActiveTimer(game_id)) {
          timerRegistry.unregisterTimer(game_id);
        }
        if (socket.id) {
          timerEventBus.emitTimerStop('ludo', game_id, socket.id, user_id, 'game_quit');
        }
        if (opponentSocketId) {
          timerEventBus.emitTimerStop('ludo', game_id, opponentSocketId, opponentId, 'game_quit');
        }
      } catch (_) {
      }

      await baseCleanupRedisKeys(game_id, gameConfig);
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
