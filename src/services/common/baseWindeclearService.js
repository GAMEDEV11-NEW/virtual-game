const cassandraClient = require('../cassandra/client');
const { redis: redisClient } = require('../../utils/redis');
const {
  GAME_STATUS,
  getCurrentMonth,
  DB_QUERIES
} = require('../../constants');
const { markMatchCompleted } = require('../../utils/matchUtils');
const { fetchMatch } = require('../../utils/redis');
const { toISOString } = require('../../utils/dateUtils');
const { getYearMonth, getCurrentDate } = require('../../utils/dateUtils');

// ============================================================================
// Fetch league_joins info for a given user and game (match_pair_id)
// ============================================================================
async function getLeagueJoinInfoForGame(userId, gameId, leagueId = null) {
  try {
    try {
      const matchPairQuery = 'SELECT user1_id, user2_id, user1_data, user2_data FROM match_pairs WHERE id = ?';
      const matchPairResult = await cassandraClient.execute(matchPairQuery, [gameId], { prepare: true });
      
      if (matchPairResult.rowLength > 0) {
        const matchPair = matchPairResult.rows[0];
        const user1Id = matchPair.user1_id ? matchPair.user1_id.toString() : '';
        const user2Id = matchPair.user2_id ? matchPair.user2_id.toString() : '';
        const user1EntryId = matchPair.user1_data ? matchPair.user1_data.toString() : '';
        const user2EntryId = matchPair.user2_data ? matchPair.user2_data.toString() : '';
        const userIdStr = userId.toString();
        
        let entryId = null;
        if (user1Id === userIdStr && user1EntryId) {
          entryId = user1EntryId;
        } else if (user2Id === userIdStr && user2EntryId) {
          entryId = user2EntryId;
        }
        
        if (entryId) {
          try {
            const entryResult = await cassandraClient.execute(DB_QUERIES.SELECT_LEAGUE_JOIN_BY_ID, [entryId], { prepare: true });
            
            if (entryResult.rowLength > 0) {
              const entryRow = entryResult.rows[0];
              let parsed = {};
              try { parsed = entryRow.extra_data ? JSON.parse(entryRow.extra_data) : {}; } catch (_) {}
              
              let entryFee = 0;
              if (entryRow.entry_fee !== null && entryRow.entry_fee !== undefined) {
                const entryFeeFromColumn = parseFloat(entryRow.entry_fee);
                if (!isNaN(entryFeeFromColumn) && entryFeeFromColumn > 0) {
                  entryFee = entryFeeFromColumn;
                }
              }
              if (entryFee === 0 && parsed && parsed.entry_fee) {
                const entryFeeFromExtra = parseFloat(parsed.entry_fee);
                if (!isNaN(entryFeeFromExtra) && entryFeeFromExtra > 0) {
                  entryFee = entryFeeFromExtra;
                }
              }
              
              const prizeAmount = parsed && parsed.prize_amount ? parseFloat(parsed.prize_amount) : 0;
              const matchPairId = entryRow.match_pair_id ? entryRow.match_pair_id.toString() : gameId;
              
              return {
                leagueId: entryRow.league_id || '',
                joinedAt: entryRow.joined_at,
                id: entryRow.id,
                matchPairId: matchPairId,
                extraData: parsed,
                entryFee: entryFee,
                prizeAmount: isNaN(prizeAmount) ? 0 : prizeAmount
              };
            }
          } catch (err) {}
        }
      }
    } catch (err) {}
    
    const joinMonth = getCurrentMonth();
    const candidateStatusIds = ['1', '2', '3', '4'];
    
    for (const statusId of candidateStatusIds) {
      const query = `
        SELECT extra_data, match_pair_id, league_id, joined_at, id, entry_fee
        FROM league_joins
        WHERE user_id = ? AND status_id = ? AND join_month = ?
      `;
      const result = await cassandraClient.execute(query, [userId, statusId, joinMonth], { prepare: true });
      for (const row of result.rows) {
        const rowMatchPairId = row.match_pair_id ? row.match_pair_id.toString() : '';
        if (rowMatchPairId && rowMatchPairId.toString() === gameId.toString()) {
          return extractJoinInfoFromRow(row, rowMatchPairId);
        }
      }
    }
    
    if (leagueId) {
      for (const statusId of candidateStatusIds) {
        const query = `
          SELECT extra_data, match_pair_id, league_id, joined_at, id, entry_fee
          FROM league_joins
          WHERE user_id = ? AND status_id = ? AND join_month = ? AND league_id = ?
        `;
        const result = await cassandraClient.execute(query, [userId, statusId, joinMonth, leagueId], { prepare: true });
        if (result.rows.length > 0) {
          const row = result.rows[result.rows.length - 1];
          const rowMatchPairId = row.match_pair_id ? row.match_pair_id.toString() : '';
          return extractJoinInfoFromRow(row, rowMatchPairId);
        }
      }
    }
    
    return null;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Helper function to extract join info from a database row
// ============================================================================
function extractJoinInfoFromRow(row, matchPairId) {
  let parsed = {};
  try { parsed = row.extra_data ? JSON.parse(row.extra_data) : {}; } catch (_) {}
  
  let entryFee = 0;
  if (row.entry_fee !== null && row.entry_fee !== undefined) {
    const entryFeeFromColumn = parseFloat(row.entry_fee);
    if (!isNaN(entryFeeFromColumn) && entryFeeFromColumn > 0) {
      entryFee = entryFeeFromColumn;
    }
  }
  
  if (entryFee === 0 && parsed && parsed.entry_fee) {
    const entryFeeFromExtra = parseFloat(parsed.entry_fee);
    if (!isNaN(entryFeeFromExtra) && entryFeeFromExtra > 0) {
      entryFee = entryFeeFromExtra;
    }
  }
  
  const prizeAmount = parsed && parsed.prize_amount ? parseFloat(parsed.prize_amount) : 0;
  return {
    leagueId: row.league_id,
    joinedAt: row.joined_at,
    id: row.id,
    matchPairId: matchPairId,
    extraData: parsed,
    entryFee: entryFee,
    prizeAmount: isNaN(prizeAmount) ? 0 : prizeAmount
  };
}

// ============================================================================
// Credit user's wallet for game win
// ============================================================================
async function creditUserWalletForWin(userID, amount, options = {}) {
  const { updateBalance = false } = options;
  try {
    const getCurrentValuesQuery = `
      SELECT balance, win, win_cr 
      FROM user_wallet 
      WHERE user_id = ?
    `;
    const currentResult = await cassandraClient.execute(getCurrentValuesQuery, [userID], { prepare: true });
    let currentBalance = 0;
    let currentWin = 0;
    let currentWinCr = 0;
    if (currentResult.rows.length > 0) {
      const row = currentResult.rows[0];
      currentBalance = parseFloat(row.balance) || 0;
      currentWin = parseFloat(row.win) || 0;
      currentWinCr = parseFloat(row.win_cr) || 0;
    }
    
    const newWin = currentWin + amount;
    const newWinCr = currentWinCr + amount;
    const newBalance = updateBalance ? currentBalance + amount : currentBalance;
    
    const updateWalletQuery = updateBalance
      ? `UPDATE user_wallet SET balance = ?, win = ?, win_cr = ?, last_updated = ? WHERE user_id = ?`
      : `UPDATE user_wallet SET win = ?, win_cr = ?, last_updated = ? WHERE user_id = ?`;
    
    const params = updateBalance
      ? [newBalance.toString(), newWin.toString(), newWinCr.toString(), new Date(), userID]
      : [newWin.toString(), newWinCr.toString(), new Date(), userID];
    
    await cassandraClient.execute(updateWalletQuery, params, { prepare: true });
    return {
      success: true,
      balanceAfter: newBalance,
      previousBalance: currentBalance,
      winAfter: newWin,
      previousWin: currentWin,
      winCrAfter: newWinCr,
      previousWinCr: currentWinCr
    };
  } catch (err) {
    return {
      success: false,
      balanceAfter: 0,
      previousBalance: 0,
      winAfter: 0,
      previousWin: 0,
      winCrAfter: 0,
      previousWinCr: 0
    };
  }
}

// ============================================================================
// Record a win transaction in user_wallet_history
// ============================================================================
async function recordWinTransaction(userID, info, amount, balanceAfter = 0, winAfter = 0, previousWin = 0, winCrAfter = 0, previousWinCr = 0, options = {}) {
  try {
    const {
      txnType = 'winnerdeclare',
      details = 'Game win credit',
      action = 'WIN'
    } = options;
    
    const txnMonth = getYearMonth();
    const txnTime = getCurrentDate();
    const txnId = (info && info.id) || require('crypto').randomUUID();
    
    const metadata = `PAYMENT=credit;action=${action};league_id=${info && info.leagueId ? info.leagueId : ''};contest_id=${info && info.contestId ? info.contestId : ''};match_pair_id=${info && info.matchPairId ? info.matchPairId : ''};entry_fee=${info && typeof info.entryFee !== 'undefined' ? info.entryFee : ''};credited_amount=${amount};game_end_reason=${info && info.gameEndReason ? info.gameEndReason : ''};game_id=${info && info.gameId ? info.gameId : ''};win_after=${winAfter};prev_win=${previousWin};win_cr_after=${winCrAfter};prev_win_cr=${previousWinCr}`;
    
    const insertQuery = `
      INSERT INTO user_wallet_history (
        user_id, type, txn_month, txn_time, txn_id, 
        amount, balance_after, metadata, win, win_cr, win_db, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await cassandraClient.execute(insertQuery, [
      userID,
      txnType,
      txnMonth,
      txnTime,
      txnId,
      amount.toString(),
      balanceAfter.toString(),
      metadata,
      winAfter.toString(),
      winCrAfter.toString() || amount.toString(),
      '0',
      details
    ], { prepare: true });
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// Insert winner declaration into database
// ============================================================================
async function insertWinnerDeclaration(gameId, userId, leagueId, contestId, status, gameEndReason = 'game_completed', prizeAmount = 0.0, userScore = 0.0, user1Score = 0.0, user2Score = 0.0, options = {}) {
  try {
    const { gameType = '' } = options;
    const now = getCurrentDate();
    const winMonth = getYearMonth();
    const winLossStatus = status === 'WIN' ? 'WIN' : 'LOSS';
    
    const query = `
      INSERT INTO winner_declarations (
        game_id, win_month, user_id, declared_at, extra_data, 
        league_id, prize_amount, rank, score, win_loss_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const gameStats = {
      user1_score: user1Score,
      user2_score: user2Score,
      game_status: GAME_STATUS.COMPLETED,
      final_result: winLossStatus,
      completed_at: toISOString()
    };
    
    if (gameType) {
      gameStats.game_type = gameType;
    }
    
    const extraData = JSON.stringify({
      contest_id: contestId,
      game_end_reason: gameEndReason,
      original_status: status,
      user1_score: user1Score,
      user2_score: user2Score,
      game_stats: gameStats
    });
    
    await cassandraClient.execute(query, [
      gameId,
      winMonth,
      userId,
      now,
      extraData,
      leagueId || '',
      prizeAmount,
      1,
      userScore,
      winLossStatus
    ], { prepare: true });
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Update match pair status to completed
// ============================================================================
async function updateMatchPairToCompleted(gameId, updateMatchPairStatusFn = null) {
  if (!gameId) {
    return false;
  }
  
  let success = true;
  try {
    await cassandraClient.execute(
      'UPDATE match_pairs SET status = ?, updated_at = ? WHERE id = ?',
      [GAME_STATUS.COMPLETED, new Date(), gameId],
      { prepare: true }
    );
  } catch (err) {
    success = false;
  }
  
  if (updateMatchPairStatusFn && typeof updateMatchPairStatusFn === 'function') {
    try {
      await updateMatchPairStatusFn(gameId, GAME_STATUS.COMPLETED);
    } catch (err) {
      success = false;
    }
  }
  
  return success;
}

// ============================================================================
// Update match pair status to winner declared
// ============================================================================
async function updateMatchPairToWinnerDeclared(gameId, updateMatchPairStatusFn = null, status = GAME_STATUS.COMPLETED) {
  return await updateMatchPairToCompleted(gameId, updateMatchPairStatusFn);
}

// ============================================================================
// Mark game as complete in Redis
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason, gameType) {
  try {
    const match = await fetchMatch(redisClient, gameId, gameType);
    if (!match) {
      return false;
    }
    
    if (match.status === GAME_STATUS.COMPLETED && match.winner) {
      return true;
    }
    
    const result = await markMatchCompleted(redisClient, gameId, winnerId, gameEndReason, gameType);
    return result;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Clean up Redis match data after game completion
// ============================================================================
async function cleanupRedisMatchData(gameId, gameType, redisKeys) {
  try {
    const { getUserChanceKey } = require('../../utils/redis');
    const matchKey = redisKeys.MATCH ? redisKeys.MATCH(gameId) : redisKeys(gameId);
    const userChanceKey = getUserChanceKey(gameId, gameType);
    
    await Promise.all([
      redisClient.del(matchKey),
      redisClient.del(userChanceKey)
    ]);
    
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// Update league join status
// ============================================================================
async function updateLeagueJoinStatus(userId, joinInfo, status = GAME_STATUS.COMPLETED) {
  try {
    if (!userId || !joinInfo || !joinInfo.joinedAt) {
      return false;
    }
    const statusId = joinInfo.statusId || '1';
    const joinMonth = joinInfo.joinMonth || getYearMonth(joinInfo.joinedAt);
    await cassandraClient.execute(
      'UPDATE league_joins SET status = ? WHERE user_id = ? AND status_id = ? AND join_month = ? AND joined_at = ?',
      [status, userId, statusId, joinMonth, joinInfo.joinedAt],
      { prepare: true }
    );
    
    if (joinInfo.id || joinInfo.entryId) {
      try {
        const { updateLeagueJoinByIdStatusOnly } = require('../ludo/gameService');
        const entryId = joinInfo.id || joinInfo.entryId;
        await updateLeagueJoinByIdStatusOnly(entryId, status);
      } catch (err) {}
    }
    
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  getLeagueJoinInfoForGame,
  creditUserWalletForWin,
  recordWinTransaction,
  insertWinnerDeclaration,
  updateMatchPairToWinnerDeclared,
  updateMatchPairToCompleted,
  markGameAsComplete,
  cleanupRedisMatchData,
  updateLeagueJoinStatus
};
