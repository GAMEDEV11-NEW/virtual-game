const { emitStandardError, validateRequiredFields } = require('../../utils/gameUtils');
const { processWinnerDeclaration } = require('../../services/snakesladders/windeclearService');
const withAuth = require('../../middleware/withAuth');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const {
  GAME_STATUS,
  GAME_END_REASONS,
  REDIS_KEYS: SHARED_REDIS_KEYS
} = require('../../constants');

const {
  getAndValidateGameMatch: baseGetAndValidateGameMatch,
  updateGameStateInRedis: baseUpdateGameStateInRedis,
  updateDatabaseRecords: baseUpdateDatabaseRecords,
  notifyOpponent: baseNotifyOpponent,
  sendQuitResponse: baseSendQuitResponse,
  stopTimers: baseStopTimers,
  cleanupRedisKeys: baseCleanupRedisKeys
} = require('../common/baseHandlers');

const REDIS_KEYS = {
  MATCH: SHARED_REDIS_KEYS.SNAKES_MATCH,
  ACTIVE_GAMES: 'snakesladders_active_games'
};

const GAME_CONFIG = {
  QUIT_PENALTY_POINTS: 0
};

function determineWinner(match, quittingUserId) {
  if (match.user1_id === quittingUserId) {
    return match.user2_id;
  } else if (match.user2_id === quittingUserId) {
    return match.user1_id;
  }
  return null;
}

function updateMatchForQuit(match, quittingUserId, reason) {
  const now = new Date().toISOString();
  const winner = determineWinner(match, quittingUserId);
  
  match.status = GAME_STATUS.COMPLETED;
  match.winner = winner;
  match.winner_id = winner;
  match.game_end_reason = reason;
  match.completed_at = now;
  match.updated_at = now;
  match.quit_by = quittingUserId;
  match.quit_at = now;
  match.quitting_user_id = quittingUserId;
  match.quit_timestamp = now; 
  
  return match;
}

function applyQuitPenalty(match, quittingUserId) {
  const penalty = GAME_CONFIG.QUIT_PENALTY_POINTS;
  
  if (match.user1_id === quittingUserId) {
    match.user1_score = Math.max(0, (match.user1_score || 0) - penalty);
  } else if (match.user2_id === quittingUserId) {
    match.user2_score = Math.max(0, (match.user2_score || 0) - penalty);
  }
  
  if (!match.scores) {
    match.scores = {};
  }
  match.scores[quittingUserId] = Math.max(0, (match.scores[quittingUserId] || 0) - penalty);
  
  return match;
}

const gameConfig = {
  getMatchKey: (gameId) => REDIS_KEYS.MATCH(gameId),
  emitError: emitStandardError,
  responseEvent: 'snakesladders_quit_game_response',
  processWinnerDeclaration: processWinnerDeclaration,
  notificationEvent: 'snakesladders_opponent_quit',
  timerStopEvent: 'stop:timer_updates_snakesladders',
  applyQuitPenalty: applyQuitPenalty,
  postProcessWinnerDeclaration: async (gameId, result, match) => {
    if (result && result.success) {
      const { updateMatchPairStatus } = require('../../services/snakesladders/gameService');
      await updateMatchPairStatus(gameId, GAME_STATUS.COMPLETED);
    }
  },
  formatNotification: (gameData) => ({
    status: 'opponent_quit',
    message: 'Your opponent has quit the game',
    game_id: gameData.gameId,
    opponent_id: gameData.userId,
    winner: gameData.opponentId,
    reason: 'manual_quit',
    game_end_reason: 'opponent_quit',
    completed_at: gameData.quitAt,
    timestamp: new Date().toISOString()
  }),
  formatResponse: (gameData) => ({
    status: 'game_lost',
    message: 'Game quit successfully. Your opponent won the game.',
    game_id: gameData.gameId,
    user_id: gameData.userId,
    game_type: 'snakes_ladders',
    final_score: gameData.finalScore || 0,
    penalty_applied: GAME_CONFIG.QUIT_PENALTY_POINTS,
    reason: 'manual_quit',
    game_end_reason: 'player_quit',
    completed_at: gameData.quitAt,
    timestamp: new Date().toISOString()
  }),
  cleanupRedisMatchData: async (gameId) => {
    const { cleanupRedisMatchData } = require('../../services/snakesladders/windeclearService');
    return cleanupRedisMatchData(gameId);
  }
};

async function updateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket) {
  return baseUpdateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket, gameConfig);
}

function validateQuitRequest(match, userId) {
  if (match.user1_id !== userId && match.user2_id !== userId) {
    return {
      canQuit: false,
      error: {
        code: 'invalid_user',
        type: 'validation',
        message: 'User is not part of this match'
      }
    };
  }
  
  if (match.status === GAME_STATUS.COMPLETED) {
    return {
      canQuit: false,
      error: {
        code: 'game_already_ended',
        type: 'game',
        message: 'Game is already completed'
      }
    };
  }
  
  return { canQuit: true };
}

function registerQuitGameHandler(io, socket) {
  socket.on('snakesladders_quit_game', async (event) => {
    try {
      await withAuth(socket, event, 'snakesladders_quit_game_response', async (user, data) => {
        if (!validateRequiredFields(socket, data, ['game_id', 'contest_id', 'session_token', 'device_id', 'jwt_token'], 'snakesladders_quit_game_response')) {
          return;
        }

        const { game_id, user_id, reason = 'manual_quit' } = data;

        const match = await baseGetAndValidateGameMatch(game_id, user_id, socket, gameConfig);
        if (!match) return;

        const validation = validateQuitRequest(match, user_id);
        if (!validation.canQuit) {
          emitStandardError(socket, validation.error, 'snakesladders_quit_game_response');
          return;
        }

        const opponentId = determineWinner(match, user_id);
        if (!opponentId) {
          emitStandardError(socket, {
            code: 'invalid_match',
            type: 'game',
            message: 'Unable to determine opponent',
            event: 'snakesladders_quit_game_response'
          });
          return;
        }

        const updatedMatch = updateMatchForQuit(match, user_id, reason);
        
        const matchWithPenalty = applyQuitPenalty(updatedMatch, user_id);
        
        const updateSuccess = await baseUpdateGameStateInRedis(matchWithPenalty, user_id, opponentId, game_id, socket, {
          ...gameConfig,
          applyQuitPenalty: null
        });
        if (!updateSuccess) return;

        const contestId = data.contest_id || 'default';
        const dbUpdateSuccess = await updateDatabaseRecords(game_id, opponentId, user_id, contestId, matchWithPenalty, socket);
        if (!dbUpdateSuccess) {
        }

        const finalScore = user_id === matchWithPenalty.user1_id ? matchWithPenalty.user1_score : matchWithPenalty.user2_score;
        const gameData = {
          gameId: game_id,
          contestId: contestId,
          userId: user_id,
          opponentId: opponentId,
          quitAt: matchWithPenalty.quit_at || new Date().toISOString(),
          finalScore: finalScore
        };

        const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'snakesladders');
        baseNotifyOpponent(io, opponentSocketId, gameData, gameConfig);

        baseSendQuitResponse(socket, gameData, gameConfig);

        baseStopTimers(io, socket, opponentSocketId, game_id, opponentId, gameData.quitAt, gameConfig);

        await baseCleanupRedisKeys(game_id, gameConfig);

      });
    } catch (error) {
      emitStandardError(socket, {
        code: 'quit_game_error',
        type: 'system',
        message: error.message || 'Failed to quit game',
        event: 'snakesladders_quit_game_response'
      });
    }
  });
}

module.exports = { 
  registerQuitGameHandler
};
