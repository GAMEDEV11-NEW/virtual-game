const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS } = require('../../constants');

// ============================================================================
// Update match score
// ============================================================================
async function updateMatchScore(gameId, userId, scoreToAdd, reason = '') {
  try {
    const key = REDIS_KEYS.SNAKES_MATCH(gameId);
    const raw = await redisClient.get(key);
    if (!raw) throw new Error('Match not found');
    const match = safeParseRedisData(raw);
    if (!match) throw new Error('Match not found');
    if (!match.scores) match.scores = {};
    const prevMapScore = parseInt(match.scores[userId] || 0) || 0;
    const nextMapScore = prevMapScore + scoreToAdd;
    match.scores[userId] = nextMapScore;

    if (match.user1_id === userId) {
      match.user1_score = (parseInt(match.user1_score) || 0) + scoreToAdd;
    } else if (match.user2_id === userId) {
      match.user2_score = (parseInt(match.user2_score) || 0) + scoreToAdd;
    }
    match.updated_at = new Date().toISOString();
    await redisClient.set(key, JSON.stringify(match));
    return { success: true, user_id: userId, score_added: scoreToAdd, new_score: nextMapScore, reason };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// Score dice roll
// ============================================================================
async function scoreDiceRoll(userId, diceNumber, gameId, gameContext = {}) {
  try {
    let totalScore = 0;
    let scoreReasons = [];
    const base = parseInt(diceNumber) || 0;
    
    // Base score for dice number
    totalScore += base;
    scoreReasons.push(`base_score_${base}`);
    
    // Bonus for rolling a six
    if (diceNumber === 6) {
      totalScore += 10;
      scoreReasons.push('rolled_six');
      
      // Bonus for consecutive sixes (but not if it's the 3rd consecutive - that loses turn)
      if (gameContext.consecutiveSixes > 1 && gameContext.consecutiveSixes < 3) {
        const consecutiveBonus = 2 * gameContext.consecutiveSixes;
        totalScore += consecutiveBonus;
        scoreReasons.push(`consecutive_six_bonus_${gameContext.consecutiveSixes}`);
      }
    }
    
    // Lucky roll bonus for rolling 1
    if (diceNumber === 1) {
      totalScore += 1;
      scoreReasons.push('lucky_roll');
    }
    
    const result = await updateMatchScore(gameId, userId, totalScore, `dice_roll: ${scoreReasons.join(', ')}`);
    if (!result.success) {
      return { points: 0, reasons: ['scoring_error'], error: result.error };
    }
    
    return {
      points: totalScore,
      reasons: scoreReasons,
      bonusScore: totalScore - base,
      diceNumber: base,
      baseScore: base,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { points: 0, reasons: ['scoring_error'], error: error.message };
  }
}

module.exports = { scoreDiceRoll, updateMatchScore };
