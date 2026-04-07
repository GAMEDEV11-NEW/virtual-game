const { redis: redisClient } = require('../../utils/redis');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { toISOString, getCurrentDate } = require('../../utils/dateUtils');
const { saveMatch, fetchMatch } = require('../../utils/redis');

const {
  getLeagueJoinInfoForGame,
  creditUserWalletForWin: baseCreditUserWalletForWin,
  recordWinTransaction: baseRecordWinTransaction,
  insertWinnerDeclaration: baseInsertWinnerDeclaration,
  markGameAsComplete: baseMarkGameAsComplete,
  cleanupRedisMatchData: baseCleanupRedisMatchData,
  updateLeagueJoinStatus
} = require('./baseWindeclearService');

// ============================================================================
// Credit wallet - only update win and win_cr (NOT balance)
// ============================================================================
async function creditUserWalletForWin(userID, amount) {
  return baseCreditUserWalletForWin(userID, amount, { updateBalance: false });
}

// ============================================================================
// Record transaction (custom metadata format)
// ============================================================================
async function recordWinTransaction(userID, info, amount, balanceAfter = 0, winAfter = 0, previousWin = 0, winCrAfter = 0, previousWinCr = 0, details = '') {
  return baseRecordWinTransaction(userID, info, amount, balanceAfter, winAfter, previousWin, winCrAfter, previousWinCr, {
    txnType: 'winnerdeclare',
    details: details || 'Game win credit - tictactoe',
    action: 'WIN'
  });
}

// ============================================================================
// Insert winner declaration with game_type
// ============================================================================
async function insertWinnerDeclaration(gameId, userId, leagueId, contestId, status, gameEndReason = 'game_completed', prizeAmount = 0.0, userScore = 0.0, user1Score = 0.0, user2Score = 0.0) {
  return baseInsertWinnerDeclaration(gameId, userId, leagueId, contestId, status, gameEndReason, prizeAmount, userScore, user1Score, user2Score, { gameType: 'tictactoe' });
}

// ============================================================================
// Update match pair status in Redis (not database)
// ============================================================================
async function updateMatchPairToWinnerDeclared(gameId) {
  try {
    const match = await fetchMatch(redisClient, gameId, 'tictactoe');
    if (match) {
      match.winner_declared = true;
      match.winner_declared_at = toISOString();
      await saveMatch(redisClient, gameId, match, 'tictactoe');
      return true;
    }
    return true;
  } catch (err) {
    return true;
  }
}

// ============================================================================
// Mark game as complete
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason = 'game_completed') {
  return baseMarkGameAsComplete(gameId, winnerId, gameEndReason, 'tictactoe');
}

// ============================================================================
// Cleanup Redis data (includes timer key)
// ============================================================================
async function cleanupRedisMatchData(gameId) {
  try {
    const { getUserChanceKey } = require('../../utils/redis');
    const matchKey = REDIS_KEYS.TICTACTOE_MATCH(gameId);
    const userChanceKey = getUserChanceKey(gameId, 'tictactoe');
    const timerKey = `tictactoe_timer:${gameId}`;
    await Promise.all([
      redisClient.del(matchKey),
      redisClient.del(userChanceKey),
      redisClient.del(timerKey)
    ]);
    
    // Clear winner declaration key if exists
    try {
      await redisClient.del(`tictactoe_winner_declared:${gameId}`);
    } catch (_) {}
    
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// Process winner declaration for Tic-Tac-Toe
// ============================================================================
async function processWinnerDeclaration(gameId, winnerId, loserId, contestId, gameEndReason = 'player_won', winnerScore = 1.0, loserScore = 0.0, user1Score = 1.0, user2Score = 0.0) {
  try {
    const now = getCurrentDate();
    
    const joinInfo = await getLeagueJoinInfoForGame(winnerId, gameId);
    const loserJoinInfo = await getLeagueJoinInfoForGame(loserId, gameId);
    
    const derivedEntryFee = joinInfo && typeof joinInfo.entryFee !== 'undefined' ? parseFloat(joinInfo.entryFee) : 0;
    const entryFeeAmount = isNaN(derivedEntryFee) ? 0 : derivedEntryFee;
    
    const prizeAmountFromJoin = joinInfo && typeof joinInfo.prizeAmount !== 'undefined' ? parseFloat(joinInfo.prizeAmount) : 0;
    const prizeAmount = (prizeAmountFromJoin > 0) ? prizeAmountFromJoin : (entryFeeAmount * 2);
    
    const actualLeagueId = (joinInfo && joinInfo.leagueId) ? joinInfo.leagueId : '';
    const actualContestId = contestId || (joinInfo && joinInfo.extraData && joinInfo.extraData.contest_id) || '';

    const ok1 = await insertWinnerDeclaration(gameId, winnerId, actualLeagueId, actualContestId, 'WIN', gameEndReason, prizeAmount, winnerScore, user1Score, user2Score);
    const ok2 = await insertWinnerDeclaration(gameId, loserId, actualLeagueId, actualContestId, 'LOSS', gameEndReason, 0.0, loserScore, user1Score, user2Score);
    const ok3 = await updateMatchPairToWinnerDeclared(gameId);
    const ok4 = await markGameAsComplete(gameId, winnerId, gameEndReason);

    await updateLeagueJoinStatus(winnerId, joinInfo, GAME_STATUS.COMPLETED);
    await updateLeagueJoinStatus(loserId, loserJoinInfo, GAME_STATUS.COMPLETED);

    let walletUpdated = false;
    if (ok1 && ok2 && ok3 && ok4 && prizeAmount > 0) {
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
      walletRes && typeof walletRes.previousWinCr !== 'undefined' ? walletRes.previousWinCr : 0);
    }

    return { 
      success: ok1 && ok2 && ok3 && ok4, 
      timestamp: now.toISOString(), 
      prize_amount: prizeAmount, 
      wallet_updated: walletUpdated,
      error: null
    };
  } catch (e) {
    return { 
      success: false, 
      error: e.message,
      timestamp: toISOString(),
      prize_amount: 0,
      wallet_updated: false
    }; 
  }
}

module.exports = { 
  processWinnerDeclaration, 
  insertWinnerDeclaration, 
  updateMatchPairToWinnerDeclared, 
  cleanupRedisMatchData, 
  markGameAsComplete
};
