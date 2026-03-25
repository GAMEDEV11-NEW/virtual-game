const { GAME_STATUS, GAME_END_REASONS } = require('../constants');
const { fetchMatch, saveMatch, updateMatchFields } = require('./redis');
const { toISOString } = require('./dateUtils');

// ============================================================================
// Checks if a match is completed
// ============================================================================
function isMatchCompleted(match) {
  if (!match) return false;
  if (match.status === GAME_STATUS.COMPLETED || match.game_status === GAME_STATUS.COMPLETED) {
    return true;
  }
  if (match.winner || match.game_end_reason) {
    return true;
  }
  return false;
}

// ============================================================================
// Checks if a match is active
// ============================================================================
function isMatchActive(match) {
  if (!match) return false;
  return match.status === GAME_STATUS.ACTIVE || 
         match.game_status === GAME_STATUS.ACTIVE;
}

// ============================================================================
// Gets the opponent user ID
// ============================================================================
function getOpponentId(match, userId) {
  if (!match || !userId) return null;
  if (match.user1_id === userId) return match.user2_id;
  if (match.user2_id === userId) return match.user1_id;
  return null;
}

// ============================================================================
// Updates match status to completed
// ============================================================================
async function markMatchCompleted(redisClient, gameId, winnerId, reason = GAME_END_REASONS.WIN, gameType = 'ludo') {
  const update = {
    status: GAME_STATUS.COMPLETED,
    game_status: GAME_STATUS.COMPLETED,
    winner: winnerId,
    completed_at: toISOString(),
    game_end_reason: reason,
    updated_at: toISOString()
  };
  return await updateMatchFields(redisClient, gameId, update, gameType);
}

// ============================================================================
// Updates match timestamps for both players
// ============================================================================
async function updateMatchTimestamps(redisClient, gameId, gameType = 'ludo') {
  const now = toISOString();
  const update = {
    user1_time: now,
    user2_time: now,
    updated_at: now
  };
  return await updateMatchFields(redisClient, gameId, update, gameType);
}

module.exports = {
  isMatchCompleted,
  isMatchActive,
  getOpponentId,
  markMatchCompleted,
  updateMatchTimestamps,
};
