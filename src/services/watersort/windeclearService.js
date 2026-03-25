const cassandraClient = require('../cassandra/client');
const { redis: redisClient } = require('../../utils/redis');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { toISOString } = require('../../utils/dateUtils');
const { getCurrentDate, getYearMonth } = require('../../utils/dateUtils');

const {
  getLeagueJoinInfoForGame,
  creditUserWalletForWin: baseCreditUserWalletForWin,
  recordWinTransaction: baseRecordWinTransaction,
  markGameAsComplete: baseMarkGameAsComplete,
  updateMatchPairToWinnerDeclared: baseUpdateMatchPairToWinnerDeclared,
  updateLeagueJoinStatus
} = require('../common/baseWindeclearService');

// ============================================================================
// Credit wallet - only update win and win_cr (NOT balance)
// ============================================================================
async function creditUserWalletForWin(userID, amount) {
  return baseCreditUserWalletForWin(userID, amount, { updateBalance: false });
}

// ============================================================================
// Record transaction
// ============================================================================
async function recordWinTransaction(userID, info, amount, balanceAfter = 0, winAfter = 0, previousWin = 0, winCrAfter = 0, previousWinCr = 0, details = '') {
  return baseRecordWinTransaction(userID, info, amount, balanceAfter, winAfter, previousWin, winCrAfter, previousWinCr, {
    txnType: 'winnerdeclare',
    details: details || 'Game win credit - watersort',
    action: 'WIN'
  });
}

// ============================================================================
// Inserts winner declarations for watersort game completion
// ============================================================================
async function insertWinnerDeclarations(gameId, winnerId, loserId, contestId, gameEndReason, gameDetails = {}, prizeAmount = 0) {
  if (!cassandraClient || !cassandraClient.execute) {
    throw new Error('Cassandra client is not available or not properly initialized');
  }

  const now = getCurrentDate();
  const winMonth = getYearMonth();
  const {
    winner_score = 0,
    loser_score = 0,
    level_no = 0,
    move_count = 0,
    game_duration = 0,
    league_id = gameId,
    match_pair_id = gameId
  } = gameDetails;

  const winnerExtraData = {
    contest_id: contestId,
    game_end_reason: gameEndReason,
    game_stats: {
      completed_at: toISOString(),
      final_result: "WIN",
      game_status: "completed",
      opponent_score: loser_score,
      user_score: winner_score,
      level_no: level_no,
      move_count: move_count,
      game_duration: game_duration
    },
    opponent_score: loser_score,
    original_status: "WIN",
    user_score: winner_score
  };

  const loserExtraData = {
    contest_id: contestId,
    game_end_reason: gameEndReason,
    game_stats: {
      completed_at: toISOString(),
      final_result: "LOSS",
      game_status: "completed",
      opponent_score: winner_score,
      user_score: loser_score,
      level_no: level_no,
      move_count: move_count,
      game_duration: game_duration
    },
    opponent_score: winner_score,
    original_status: "LOSS",
    user_score: loser_score
  };

  const winnerQuery = `
    INSERT INTO winner_declarations (
      game_id, win_month, user_id, declared_at, extra_data, league_id, 
      prize_amount, rank, score, win_loss_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  try {
    await cassandraClient.execute(winnerQuery, [
      gameId, winMonth, winnerId, now, JSON.stringify(winnerExtraData), league_id,
      prizeAmount, 1, winner_score, 'WIN'
    ], { prepare: true });
  } catch (err) {
    throw err;
  }

  const loserQuery = `
    INSERT INTO winner_declarations (
      game_id, win_month, user_id, declared_at, extra_data, league_id, 
      prize_amount, rank, score, win_loss_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  try {
    await cassandraClient.execute(loserQuery, [
      gameId, winMonth, loserId, now, JSON.stringify(loserExtraData), league_id,
      0.0, 2, loser_score, 'LOSS'
    ], { prepare: true });
  } catch (err) {
    throw err;
  }

  return { success: true, timestamp: toISOString() };
}

// ============================================================================
// Updates match pair status in Redis
// ============================================================================
async function updateMatchPairStatus(gameId, status) {
  const { safeParseRedisData } = require('../../utils/gameUtils');
  const matchKey = REDIS_KEYS.WATERSORT_MATCH(gameId);
  const raw = await redisClient.get(matchKey);
  if (raw) {
    const match = safeParseRedisData(raw);
    if (!match) return;
    match.status = status;
    await redisClient.set(matchKey, JSON.stringify(match));
  }
}

// ============================================================================
// Marks game as complete in Redis
// ============================================================================
async function markGameAsComplete(gameId, winnerId, gameEndReason = 'puzzle_completed') {
  return baseMarkGameAsComplete(gameId, winnerId, gameEndReason, 'watersort');
}

// ============================================================================
// Processes winner declaration for watersort game
// ============================================================================
async function processWinnerDeclaration(gameId, winnerId, loserId, contestId, gameEndReason = 'puzzle_completed', gameDetails = {}) {
  try {
    let actualMatchPairId = gameId;
    let matchLeagueId = null;

    try {
      const matchKey = REDIS_KEYS.WATERSORT_MATCH(gameId);
      const raw = await redisClient.get(matchKey);
      if (raw) {
        const match = JSON.parse(raw);
        if (match.game_id) {
          actualMatchPairId = match.game_id;
        }
        matchLeagueId = match.league_id || gameDetails.league_id || null;
      }

      if (actualMatchPairId === gameId) {
        try {
          const byIdResult = await cassandraClient.execute(
            'SELECT id, user1_id, user2_id FROM match_pairs WHERE id = ?',
            [gameId],
            { prepare: true }
          );

          if (byIdResult.rowLength > 0) {
            const row = byIdResult.rows[0];
            const user1 = row.user1_id ? row.user1_id.toString() : '';
            const user2 = row.user2_id ? row.user2_id.toString() : '';
            const w = winnerId.toString();
            const l = loserId.toString();

            if ((user1 === w && user2 === l) || (user1 === l && user2 === w)) {
              actualMatchPairId = row.id.toString();
            }
          }
        } catch (e) {
        }
      }
    } catch (err) {
      matchLeagueId = gameDetails.league_id || null;
    }

    let winnerJoinInfo = await getLeagueJoinInfoForGame(winnerId, actualMatchPairId, matchLeagueId);
    let loserJoinInfo = await getLeagueJoinInfoForGame(loserId, actualMatchPairId, matchLeagueId);

    if (!winnerJoinInfo) {
      winnerJoinInfo = await getLeagueJoinInfoForGame(winnerId, gameId, matchLeagueId);
    }
    if (!loserJoinInfo) {
      loserJoinInfo = await getLeagueJoinInfoForGame(loserId, gameId, matchLeagueId);
    }

    const winnerEntryFee = winnerJoinInfo && typeof winnerJoinInfo.entryFee !== 'undefined' ? parseFloat(winnerJoinInfo.entryFee) : 0;
    const winnerEntryFeeAmount = isNaN(winnerEntryFee) ? 0 : winnerEntryFee;

    const loserEntryFee = loserJoinInfo && typeof loserJoinInfo.entryFee !== 'undefined' ? parseFloat(loserJoinInfo.entryFee) : 0;
    const loserEntryFeeAmount = isNaN(loserEntryFee) ? 0 : loserEntryFee;

    const totalEntryFees = winnerEntryFeeAmount + loserEntryFeeAmount;

    const prizeAmountFromJoin = winnerJoinInfo && typeof winnerJoinInfo.prizeAmount !== 'undefined' ? parseFloat(winnerJoinInfo.prizeAmount) : 0;
    const prizeAmount = (prizeAmountFromJoin > 0) ? prizeAmountFromJoin : totalEntryFees;

    const joinInfo = winnerJoinInfo || loserJoinInfo;

    const finalMatchPairId = (joinInfo && joinInfo.matchPairId) ? joinInfo.matchPairId : actualMatchPairId;

    const actualLeagueId = (joinInfo && joinInfo.leagueId) ? joinInfo.leagueId : (gameDetails.league_id || gameId);

    const actualContestId = contestId || (joinInfo && joinInfo.extraData && joinInfo.extraData.contest_id) || '';

    const actualWinnerScore = gameDetails.winner_score || 0;
    const actualLoserScore = gameDetails.loser_score || 0;
    const result = await insertWinnerDeclarations(finalMatchPairId, winnerId, loserId, actualContestId, gameEndReason, {
      ...gameDetails,
      league_id: actualLeagueId,
      match_pair_id: finalMatchPairId,
      winner_score: actualWinnerScore,
      loser_score: actualLoserScore
    }, prizeAmount);

    await baseUpdateMatchPairToWinnerDeclared(finalMatchPairId, updateMatchPairStatus);

    await updateLeagueJoinStatus(winnerId, winnerJoinInfo, GAME_STATUS.COMPLETED);
    await updateLeagueJoinStatus(loserId, loserJoinInfo, GAME_STATUS.COMPLETED);

    await markGameAsComplete(gameId, winnerId, gameEndReason);

    let walletUpdated = false;
    if (prizeAmount > 0) {
      const walletRes = await creditUserWalletForWin(winnerId, prizeAmount);
      walletUpdated = walletRes && walletRes.success === true;

      if (walletUpdated) {
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
          `WaterSort win credited: prize=${prizeAmount}`);
      }
    }
    return {
      success: true,
      timestamp: result.timestamp,
      prize_amount: prizeAmount,
      wallet_updated: walletUpdated
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  updateMatchPairStatus,
  markGameAsComplete,
  processWinnerDeclaration
};
