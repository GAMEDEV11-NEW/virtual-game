const { redis: redisClient, safeParseRedisData } = require('../../utils/redis');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { toISOString } = require('../../utils/dateUtils');
const { getCurrentDate } = require('../../utils/dateUtils');
const { archiveLudoGameState } = require('./archiveService');

const {
  getLeagueJoinInfoForGame,
  creditUserWalletForWin: baseCreditUserWalletForWin,
  recordWinTransaction: baseRecordWinTransaction,
  insertWinnerDeclaration: baseInsertWinnerDeclaration,
  updateMatchPairToWinnerDeclared: baseUpdateMatchPairToWinnerDeclared,
  markGameAsComplete: baseMarkGameAsComplete,
  cleanupRedisMatchData: baseCleanupRedisMatchData,
  updateLeagueJoinStatus
} = require('../common/baseWindeclearService');

// ============================================================================
// Credit wallet without updating balance (only win/win_cr)
// ============================================================================
async function creditUserWalletForWin(userID, amount) {
  return baseCreditUserWalletForWin(userID, amount, { updateBalance: false });
}

// ============================================================================
// Record transaction with 'credit' type
// ============================================================================
async function recordWinTransaction(userID, info, amount, balanceAfter = 0, winAfter = 0, previousWin = 0, winCrAfter = 0, previousWinCr = 0, details = '') {
  return baseRecordWinTransaction(userID, info, amount, balanceAfter, winAfter, previousWin, winCrAfter, previousWinCr, {
    txnType: 'credit',
    details: details || 'Game win credit - ludo',
    action: 'game_win'
  });
}

// ============================================================================
// Insert winner declaration
// ============================================================================
async function insertWinnerDeclaration(gameId, userId, leagueId, contestId, status, gameEndReason = 'game_completed', prizeAmount = 0.0, userScore = 0.0, user1Score = 0.0, user2Score = 0.0) {
  return baseInsertWinnerDeclaration(gameId, userId, leagueId, contestId, status, gameEndReason, prizeAmount, userScore, user1Score, user2Score);
}

// ============================================================================
// Update match pair status
// ============================================================================
async function updateMatchPairToWinnerDeclared(gameId) {
  return baseUpdateMatchPairToWinnerDeclared(gameId);
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

  const result = await baseCleanupRedisMatchData(gameId, 'ludo', REDIS_KEYS);
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
  } catch (_) {}
  
  // Also clear winner declaration key if it exists
  try {
    await redisClient.del(`ludo_winner_declared:${gameId}`);
  } catch (_) {}
  
  return result;
}

// ============================================================================
// Mark game as complete
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason = 'game_completed') {
  return baseMarkGameAsComplete(gameId, winnerId, gameEndReason, 'ludo');
}

// ============================================================================
// Process winner declaration for ludo game
// ============================================================================
async function processWinnerDeclaration(gameId, winnerId, loserId, contestId, gameEndReason = 'game_completed', winnerScore = 0.0, loserScore = 0.0, user1Score = 0.0, user2Score = 0.0) {
  try {
    const now = getCurrentDate();
    
    const joinInfo = await getLeagueJoinInfoForGame(winnerId, gameId);
    const loserJoinInfo = await getLeagueJoinInfoForGame(loserId, gameId);
    const derivedEntryFee = joinInfo && typeof joinInfo.entryFee !== 'undefined' ? parseFloat(joinInfo.entryFee) : 0;
    const entryFeeAmount = isNaN(derivedEntryFee) ? 0 : derivedEntryFee;
    const prizeAmount = entryFeeAmount * 2;
    
    const actualLeagueId = (joinInfo && joinInfo.leagueId) ? joinInfo.leagueId : '';
    const actualContestId = contestId || (joinInfo && joinInfo.extraData && joinInfo.extraData.contest_id) || '';

    const ok1 = await insertWinnerDeclaration(gameId, winnerId, actualLeagueId, actualContestId, 'WIN', gameEndReason, prizeAmount, winnerScore, user1Score, user2Score);
    const ok2 = await insertWinnerDeclaration(gameId, loserId, actualLeagueId, actualContestId, 'LOSS', gameEndReason, 0.0, loserScore, user1Score, user2Score);
    const ok3 = await updateMatchPairToWinnerDeclared(gameId);
    const ok4 = await markGameAsComplete(gameId, winnerId, gameEndReason);

    await updateLeagueJoinStatus(winnerId, joinInfo, GAME_STATUS.COMPLETED);
    await updateLeagueJoinStatus(loserId, loserJoinInfo, GAME_STATUS.COMPLETED);

    const failedOps = [];
    if (!ok1) failedOps.push('insertWinnerDeclaration(WIN)');
    if (!ok2) failedOps.push('insertWinnerDeclaration(LOSS)');
    if (!ok3) failedOps.push('updateMatchPairToWinnerDeclared');
    
    const criticalSuccess = ok1 && ok2 && ok3;
    
    let walletUpdated = false;
    if (criticalSuccess && prizeAmount > 0) {
      const walletRes = await creditUserWalletForWin(winnerId, prizeAmount);
      walletUpdated = walletRes && walletRes.success === true;
      await recordWinTransaction(winnerId, {
        leagueId: joinInfo ? joinInfo.leagueId : undefined,
        contestId,
        matchPairId: joinInfo ? joinInfo.matchPairId : undefined,
        entryFee: joinInfo ? joinInfo.entryFee : undefined,
        gameEndReason,
        gameId
      }, prizeAmount,
        walletRes && walletRes.balanceAfter ? walletRes.balanceAfter : 0,
        walletRes && typeof walletRes.winAfter !== 'undefined' ? walletRes.winAfter : 0,
        walletRes && typeof walletRes.previousWin !== 'undefined' ? walletRes.previousWin : 0,
        walletRes && typeof walletRes.winCrAfter !== 'undefined' ? walletRes.winCrAfter : 0,
        walletRes && typeof walletRes.previousWinCr !== 'undefined' ? walletRes.previousWinCr : 0,
        `Ludo win credited: prize=${prizeAmount}`);
    }

    if (!criticalSuccess) {
      const errorMsg = `Critical database operations failed: ${failedOps.join(', ')}`;
      return { success: false, error: errorMsg, timestamp: now.toISOString(), prize_amount: prizeAmount, wallet_updated: walletUpdated };
    }

    return { success: true, timestamp: now.toISOString(), prize_amount: prizeAmount, wallet_updated: walletUpdated };
  } catch (e) {
    const errorMsg = e?.message || e?.toString() || 'Unknown error occurred';
    return { success: false, error: errorMsg, errorStack: e?.stack || 'No stack trace available' };
  }
}

module.exports = { processWinnerDeclaration, insertWinnerDeclaration, updateMatchPairToWinnerDeclared, cleanupRedisMatchData, markGameAsComplete };
