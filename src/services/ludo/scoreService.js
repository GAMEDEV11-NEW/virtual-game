const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS } = require('../../constants');

// ============================================================================
// Update match score
// ============================================================================
async function updateMatchScore(gameId, userId, scoreToAdd, scoreReason = '') {
  try {
    const matchKey = REDIS_KEYS.MATCH(gameId);
    const matchRaw = await redisClient.get(matchKey);
    if (!matchRaw) throw new Error('Match not found');
    const matchData = safeParseRedisData(matchRaw);
    if (!matchData) throw new Error('Match not found');
    let isUser1 = false;
    let isUser2 = false;
    if (matchData.user1_id === userId) isUser1 = true; else if (matchData.user2_id === userId) isUser2 = true; else throw new Error('User not part of this match');
    if (!matchData.scores) matchData.scores = {};
    let currentScore = 0;
    if (isUser1) currentScore = parseInt(matchData.user1_score) || 0; else currentScore = parseInt(matchData.user2_score) || 0;
    const newScore = currentScore + scoreToAdd;
    if (isUser1) matchData.user1_score = newScore; else matchData.user2_score = newScore;
    matchData.scores[userId] = newScore;
    matchData.updated_at = new Date().toISOString();
    await redisClient.set(matchKey, JSON.stringify(matchData));
    const globalScoreKey = `user_total_score:${userId}`;
    await redisClient.del(globalScoreKey);
    return { success: true, user_id: userId, previous_score: currentScore, score_added: scoreToAdd, new_score: newScore, reason: scoreReason, timestamp: new Date().toISOString() };
  } catch (error) {
    return { success: false, error: error.message, user_id: userId, game_id: gameId };
  }
}

// ============================================================================
// Score dice roll
// ============================================================================
async function scoreDiceRoll(userId, diceNumber, gameId, gameContext = {}) {
  try {
    let totalScore = 0; let scoreReasons = [];
    if (diceNumber === 6) {
      totalScore += 10; scoreReasons.push('rolled_six');
      if (gameContext.isFirstSix) { totalScore += 5; scoreReasons.push('first_six_of_game'); }
      if (gameContext.consecutiveSixes > 1) { const consecutiveBonus = 2 * gameContext.consecutiveSixes; totalScore += consecutiveBonus; scoreReasons.push(`consecutive_six_bonus_${gameContext.consecutiveSixes}`); }
    }
    if (diceNumber === 1) { totalScore += 1; scoreReasons.push('lucky_roll'); }
    const baseScore = diceNumber; totalScore += baseScore; scoreReasons.push(`base_score_${diceNumber}`);
    const scoreUpdate = await updateMatchScore(gameId, userId, totalScore, `dice_roll: ${scoreReasons.join(', ')}`);
    if (!scoreUpdate.success) throw new Error(`Failed to update match score: ${scoreUpdate.error}`);
    return { points: totalScore, reasons: scoreReasons, diceNumber, baseScore, bonusScore: totalScore - baseScore, timestamp: new Date().toISOString() };
  } catch (error) {
    return { points: 0, reasons: ['scoring_error'], error: error.message };
  }
}

// ============================================================================
// Score piece move
// ============================================================================
async function scorePieceMove(userId, fromPos, toPos, gameId, isKill = false, isHomeReach = false, isSafeMove = false) {
  try {
    let totalScore = 0; let scoreReasons = [];
    if (isKill) { totalScore += 10; scoreReasons.push('killed_opponent_piece'); }
    if (isHomeReach) {
      totalScore += 15; scoreReasons.push('piece_reached_home');
      if (fromPos && toPos === 'home') { const fromPosNum = parseInt(fromPos); if (!isNaN(fromPosNum) && fromPosNum <= 6) { totalScore += 5; scoreReasons.push('perfect_move_to_home'); } }
    }
    if (isSafeMove) { totalScore += 2; scoreReasons.push('landed_on_safe_square'); }
    if (totalScore > 0) { const scoreUpdate = await updateMatchScore(gameId, userId, totalScore, `piece_move: ${scoreReasons.join(', ')}`); if (!scoreUpdate.success) throw new Error(`Failed to update match score: ${scoreUpdate.error}`); }
    return { points: totalScore, reasons: scoreReasons, fromPos, toPos, isKill, isHomeReach, isSafeMove, timestamp: new Date().toISOString() };
  } catch (error) { return { points: 0, reasons: ['scoring_error'], error: error.message }; }
}

module.exports = {
  scoreDiceRoll,
  scorePieceMove,
};
