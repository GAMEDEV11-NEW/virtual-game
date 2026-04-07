const axios = require('axios');
const { redis: redisClient, safeParseRedisData } = require('../../utils/redis');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { getCurrentDate } = require('../../utils/dateUtils');
const { archiveLudoGameState } = require('./archiveService');
const { updateMatchPairStatus } = require('./gameService');
const mysqlClient = require('../mysql/client');

async function notifyWinnerApi(payload) {
  const url = String(process.env.LUDO_WINNER_API_URL || '').trim();
  if (!url) {
    return { success: true, skipped: true, reason: 'winner_api_url_not_configured' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const bearer = String(process.env.LUDO_WINNER_API_BEARER_TOKEN || '').trim();
    const apiKey = String(process.env.LUDO_WINNER_API_KEY || '').trim();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (apiKey) headers['x-api-key'] = apiKey;

    const timeout = Number(process.env.LUDO_WINNER_API_TIMEOUT_MS || 5000);
    await axios.post(url, payload, {
      headers,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || 'winner_api_failed' };
  }
}

async function updateMysqlGameWinner(gameId, winnerId, gameEndReason) {
  try {
    const endedAt = new Date();
    await mysqlClient.execute(
      `UPDATE ludo_game
       SET status = ?,
           status_id = ?,
           winner_user_id = ?,
           ended_at = COALESCE(ended_at, ?),
           updated_at = NOW(3)
       WHERE match_id = ? AND is_deleted = 0`,
      [GAME_STATUS.COMPLETED, 3, winnerId, endedAt, gameId]
    );
    return { success: true, endedAt: endedAt.toISOString() };
  } catch (error) {
    return { success: false, error: error?.message || 'mysql_winner_update_failed' };
  }
}

// ============================================================================
// Cleanup Redis data
// ============================================================================
async function cleanupRedisMatchData(gameId, finalMatchData = null) {
  let archivePayload = finalMatchData;
  if (!archivePayload) {
    try {
      const raw = await redisClient.get(REDIS_KEYS.MATCH(gameId));
      archivePayload = safeParseRedisData(raw);
    } catch (_) {
    }
  }
  try {
    await archiveLudoGameState(gameId, archivePayload, 'winner_cleanup');
  } catch (_) {
  }

  let result = true;
  try {
    await redisClient.del(REDIS_KEYS.MATCH(gameId));
  } catch (_) {
    result = false;
  }

  try {
    const matchServerKeys = await redisClient.scan(`match_server:${String(gameId)}:*`, { count: 100 });
    if (Array.isArray(matchServerKeys) && matchServerKeys.length > 0) {
      for (const key of matchServerKeys) {
        try {
          await redisClient.del(key);
        } catch (_) {
        }
      }
    }
  } catch (_) {
  }

  try {
    await redisClient.del(`ludo_winner_declared:${gameId}`);
  } catch (_) {
  }

  return result;
}

// ============================================================================
// Mark game as complete in Redis state
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason = 'game_completed') {
  try {
    const raw = await redisClient.get(REDIS_KEYS.MATCH(gameId));
    const match = safeParseRedisData(raw);
    if (!match || typeof match !== 'object') return true;

    const nowIso = new Date().toISOString();
    match.status = GAME_STATUS.COMPLETED;
    match.winner = winnerId;
    match.game_end_reason = gameEndReason;
    match.completed_at = nowIso;
    match.updated_at = nowIso;

    await redisClient.set(REDIS_KEYS.MATCH(gameId), JSON.stringify(match));
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// Process winner declaration for ludo game (simplified: MySQL + one API)
// ============================================================================
async function processWinnerDeclaration(
  gameId,
  winnerId,
  loserId,
  contestId,
  gameEndReason = 'game_completed',
  winnerScore = 0.0,
  loserScore = 0.0,
  user1Score = 0.0,
  user2Score = 0.0
) {
  try {
    const now = getCurrentDate();
    const timestamp = now.toISOString();

    const matchStatusRes = await updateMatchPairStatus(gameId, GAME_STATUS.COMPLETED)
      .then(() => ({ success: true }))
      .catch((e) => ({ success: false, error: e?.message || 'match_status_update_failed' }));

    const mysqlWinnerRes = await updateMysqlGameWinner(gameId, winnerId, gameEndReason);
    const redisRes = await markGameAsComplete(gameId, winnerId, gameEndReason);

    if (!mysqlWinnerRes.success || !redisRes) {
      const errors = [];
      if (!mysqlWinnerRes.success) errors.push(mysqlWinnerRes.error);
      if (!redisRes) errors.push('redis_mark_complete_failed');
      if (!matchStatusRes.success) errors.push(matchStatusRes.error);
      return {
        success: false,
        error: errors.join(' | ') || 'winner_declaration_failed',
        timestamp
      };
    }

    const apiPayload = {
      game_id: String(gameId || ''),
      winner_user_id: String(winnerId || ''),
      loser_user_id: String(loserId || ''),
      contest_id: String(contestId || ''),
      game_end_reason: String(gameEndReason || 'game_completed'),
      winner_score: Number(winnerScore || 0),
      loser_score: Number(loserScore || 0),
      user1_score: Number(user1Score || 0),
      user2_score: Number(user2Score || 0),
      declared_at: timestamp
    };

    const winnerApiRes = await notifyWinnerApi(apiPayload);

    return {
      success: true,
      timestamp,
      api_called: !winnerApiRes.skipped,
      api_status: winnerApiRes.success ? 'ok' : 'failed',
      api_error: winnerApiRes.success ? '' : (winnerApiRes.error || 'winner_api_failed')
    };
  } catch (e) {
    return {
      success: false,
      error: e?.message || e?.toString() || 'Unknown error occurred',
      errorStack: e?.stack || 'No stack trace available'
    };
  }
}

// Kept for backward compatibility where imported elsewhere.
async function insertWinnerDeclaration() {
  return true;
}

async function updateMatchPairToWinnerDeclared(gameId) {
  try {
    await updateMatchPairStatus(gameId, GAME_STATUS.COMPLETED);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  processWinnerDeclaration,
  insertWinnerDeclaration,
  updateMatchPairToWinnerDeclared,
  cleanupRedisMatchData,
  markGameAsComplete
};
