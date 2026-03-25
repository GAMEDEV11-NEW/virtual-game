const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS } = require('../../constants');

// ============================================================================
// Grant home reach extra turn
// ============================================================================
async function grantHomeReachExtraTurn(gameID, userID) {
  try {
    const matchKey = REDIS_KEYS.MATCH(gameID);
    const matchRaw = await redisClient.get(matchKey);
    if (!matchRaw) return null;
    const match = safeParseRedisData(matchRaw);
    if (!match) return null;
    const now = new Date().toISOString();
    match.turn = userID;
    match.user1_time = now;
    match.user2_time = now;
    await redisClient.set(matchKey, JSON.stringify(match));
    return match;
  } catch (_err) {
    return null;
  }
}

module.exports = { grantHomeReachExtraTurn };
