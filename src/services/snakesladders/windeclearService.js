const { redis: redisClient } = require('../../utils/redis');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');

const {
  getLeagueJoinInfoForGame,
  creditUserWalletForWin: baseCreditUserWalletForWin,
  recordWinTransaction: baseRecordWinTransaction,
  insertWinnerDeclaration: baseInsertWinnerDeclaration,
  updateMatchPairToWinnerDeclared: baseUpdateMatchPairToWinnerDeclared,
  markGameAsComplete: baseMarkGameAsComplete,
  cleanupRedisMatchData: baseCleanupRedisMatchData,
  updateLeagueJoinStatus
} = require('./baseWindeclearService');

// ============================================================================
// Credit wallet (win fields only)
// ============================================================================
async function creditUserWalletForWin(userID, amount) {
  const cassandraClient = require('../../services/cassandra/client');
  try {
    const getCurrentValuesQuery = `
      SELECT win, win_cr, win_db 
      FROM user_wallet 
      WHERE user_id = ?
    `;
    const currentResult = await cassandraClient.execute(getCurrentValuesQuery, [userID], { prepare: true });
    let currentWin = 0;
    let currentWinCr = 0;
    let currentWinDb = 0;
    if (currentResult.rows.length > 0) {
      const row = currentResult.rows[0];
      currentWin = parseFloat(row.win) || 0;
      currentWinCr = parseFloat(row.win_cr) || 0;
      currentWinDb = parseFloat(row.win_db) || 0;
    }
    
    const newWin = currentWin + amount;
    const newWinCr = currentWinCr + amount;
    const newWinDb = currentWinDb + amount;
    
    const updateWalletQuery = `UPDATE user_wallet SET win = ?, win_cr = ?, win_db = ?, last_updated = ? WHERE user_id = ?`;
    const params = [newWin.toString(), newWinCr.toString(), newWinDb.toString(), new Date(), userID];
    
    await cassandraClient.execute(updateWalletQuery, params, { prepare: true });
    return {
      success: true,
      balanceAfter: 0,
      previousBalance: 0,
      winAfter: newWin,
      previousWin: currentWin,
      winCrAfter: newWinCr,
      previousWinCr: currentWinCr,
      winDbAfter: newWinDb,
      previousWinDb: currentWinDb
    };
  } catch (err) {
    return {
      success: false,
      balanceAfter: 0,
      previousBalance: 0,
      winAfter: 0,
      previousWin: 0,
      winCrAfter: 0,
      previousWinCr: 0,
      winDbAfter: 0,
      previousWinDb: 0
    };
  }
}

// ============================================================================
// Record transaction with win_db support
// ============================================================================
async function recordWinTransaction(userID, info, amount, balanceAfter = 0, winAfter = 0, previousWin = 0, winCrAfter = 0, previousWinCr = 0, winDbAfter = 0, previousWinDb = 0, details = '') {
  const cassandraClient = require('../../services/cassandra/client');
  const { getYearMonth, getCurrentDate } = require('../../utils/dateUtils');
  try {
    const txnMonth = getYearMonth();
    const txnTime = getCurrentDate();
    const txnId = (info && info.id) || require('crypto').randomUUID();
    
    const metadata = `PAYMENT=credit;action=WIN;league_id=${info && info.leagueId ? info.leagueId : ''};contest_id=${info && info.contestId ? info.contestId : ''};match_pair_id=${info && info.matchPairId ? info.matchPairId : ''};entry_fee=${info && typeof info.entryFee !== 'undefined' ? info.entryFee : ''};credited_amount=${amount};game_end_reason=${info && info.gameEndReason ? info.gameEndReason : ''};game_id=${info && info.gameId ? info.gameId : ''};win_after=${winAfter};prev_win=${previousWin};win_cr_after=${winCrAfter};prev_win_cr=${previousWinCr};win_db_after=${winDbAfter};prev_win_db=${previousWinDb}`;
    
    const insertQuery = `
      INSERT INTO user_wallet_history (
        user_id, type, txn_month, txn_time, txn_id, 
        amount, balance_after, metadata, win, win_cr, win_db, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await cassandraClient.execute(insertQuery, [
      userID,
      'winnerdeclare',
      txnMonth,
      txnTime,
      txnId,
      amount.toString(),
      balanceAfter.toString(),
      metadata,
      winAfter.toString(),
      winCrAfter.toString(),
      winDbAfter.toString(),
      details || 'Game win credit - snakes_ladders'
    ], { prepare: true });
    return true;
  } catch (err) {
    return false;
  }
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
// Cleanup Redis keys for the match
// ============================================================================
async function cleanupRedisMatchData(gameId) {
  try {
    const { getUserChanceKey } = require('../../utils/redis');
    const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
    const userChanceKey = getUserChanceKey(gameId, 'snakesladders');
    const timerKey = `snakesladders_timer:${gameId}`;
    
    await Promise.all([
      redisClient.del(matchKey),
      redisClient.del(userChanceKey),
      redisClient.del(timerKey),
      redisClient.srem('snakesladders_active_games', gameId)
    ]);
    
    // Clear winner declaration key if exists
    try {
      await redisClient.del(`snakesladders_winner_declared:${gameId}`);
    } catch (_) {}
    
    const pattern = `snakesladders_*:${gameId}`;
    let cursor = '0';
    const batch = [];
    do {
      const res = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = Array.isArray(res) ? res[0] : '0';
      const keys = Array.isArray(res) ? (res[1] || []) : [];

      for (const k of keys) {
        batch.push(k);
        if (batch.length >= 200) {
          await redisClient.del(...batch);
          batch.length = 0;
        }
      }
    } while (cursor !== '0');

    if (batch.length > 0) {
      await redisClient.del(...batch);
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Mark game as complete
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason = 'game_completed') {
  return baseMarkGameAsComplete(gameId, winnerId, gameEndReason, 'snakesladders');
}

// ============================================================================
// Process winner declaration with all database operations
// ============================================================================
async function processWinnerDeclaration(gameId, winnerId, loserId, contestId, gameEndReason = 'game_completed', winnerScore = 0.0, loserScore = 0.0, user1Score = 0.0, user2Score = 0.0) {
  try {
    const now = new Date();
    
    const cassandraClient = require('../../services/cassandra/client');
    const { getYearMonth } = require('../../utils/dateUtils');
    
    try {
      const currentMonth = getYearMonth(now);
      const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const previousMonth = getYearMonth(previousMonthDate);
      
      const monthsToCheck = [currentMonth, previousMonth];
      let existing = null;
      
      for (const winMonth of monthsToCheck) {
        const checkQuery = `SELECT game_id, user_id, prize_amount, win_loss_status FROM winner_declarations WHERE game_id = ? AND win_month = ?`;
        const checkResult = await cassandraClient.execute(checkQuery, [gameId, winMonth], { prepare: true });
        
        const winEntry = checkResult.rows.find(row => row.win_loss_status === 'WIN');
        if (winEntry) {
          existing = winEntry;
          break;
        }
      }
      
      if (existing) {
        return { 
          success: true, 
          timestamp: now.toISOString(), 
          prize_amount: parseFloat(existing.prize_amount) || 0, 
          wallet_updated: false,
          already_declared: true
        };
      }
    } catch (checkErr) {
    }
    
    const joinInfo = await getLeagueJoinInfoForGame(winnerId, gameId);
    const loserJoinInfo = await getLeagueJoinInfoForGame(loserId, gameId);
    const derivedEntryFee = joinInfo && typeof joinInfo.entryFee !== 'undefined' ? parseFloat(joinInfo.entryFee) : 0;
    const entryFeeAmount = isNaN(derivedEntryFee) ? 0 : derivedEntryFee;
    
    const prizeAmountFromJoin = joinInfo && typeof joinInfo.prizeAmount !== 'undefined' ? parseFloat(joinInfo.prizeAmount) : 0;
    const prizeAmount = (prizeAmountFromJoin > 0) ? prizeAmountFromJoin : (entryFeeAmount * 2);
    
    const actualLeagueId = (joinInfo && joinInfo.leagueId) ? joinInfo.leagueId : '';
    const actualContestId = contestId || (joinInfo && joinInfo.extraData && joinInfo.extraData.contest_id) || '';

    const finalLoserScore = loserScore > 0 ? loserScore : (winnerScore === user1Score ? user2Score : user1Score);
    const ok1 = await insertWinnerDeclaration(gameId, winnerId, actualLeagueId, actualContestId, 'WIN', gameEndReason, prizeAmount, winnerScore, user1Score, user2Score);
    const ok2 = await insertWinnerDeclaration(gameId, loserId, actualLeagueId, actualContestId, 'LOSS', gameEndReason, 0.0, finalLoserScore, user1Score, user2Score);
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
      0,
      walletRes && typeof walletRes.winAfter !== 'undefined' ? walletRes.winAfter : 0,
      walletRes && typeof walletRes.previousWin !== 'undefined' ? walletRes.previousWin : 0,
      walletRes && typeof walletRes.winCrAfter !== 'undefined' ? walletRes.winCrAfter : 0,
      walletRes && typeof walletRes.previousWinCr !== 'undefined' ? walletRes.previousWinCr : 0,
      walletRes && typeof walletRes.winDbAfter !== 'undefined' ? walletRes.winDbAfter : 0,
      walletRes && typeof walletRes.previousWinDb !== 'undefined' ? walletRes.previousWinDb : 0,
      `Snakes & Ladders win credited: prize=${prizeAmount}`);
      
    }

    const result = { 
      success: ok1 && ok2 && ok3 && ok4, 
      timestamp: now.toISOString(), 
      prize_amount: prizeAmount, 
      wallet_updated: walletUpdated 
    };
    
    return result;
  } catch (e) { 
    return { success: false, error: e.message };
  }
}

module.exports = { 
  processWinnerDeclaration, 
  insertWinnerDeclaration, 
  updateMatchPairToWinnerDeclared, 
  cleanupRedisMatchData, 
  markGameAsComplete 
};
