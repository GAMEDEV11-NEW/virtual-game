const cassandraClient = require('../cassandra/client');
const { GAME_STATUS, DB_QUERIES, getCurrentMonth } = require('../../constants');

// ============================================================================
// Get user by mobile number
// ============================================================================
async function getUserByMobile(mobileNo) {
  if (mobileNo == null) {
    return null;
  }
  try {
    const mapRes = await cassandraClient.execute(
      'SELECT user_id FROM user_by_mobile WHERE mobile_no = ?',
      [mobileNo],
      { prepare: true }
    );

    if (mapRes.rowLength > 0) {
      const userId = mapRes.rows[0]?.user_id;
      if (userId) {
        const userRes = await cassandraClient.execute(
          'SELECT id, mobile_no, full_name, status, language_code, profile_data FROM users WHERE id = ?',
          [userId],
          { prepare: true }
        );
        if (userRes.rowLength > 0) {
          return userRes.rows[0];
        }
      }
    }
  } catch (err) {}

  return null;
}

// ============================================================================
// Get user by ID
// ============================================================================
async function getUserById(userId) {
  if (userId == null) {
    return null;
  }
  const query = 'SELECT id, mobile_no, full_name, status, language_code, profile_data FROM users WHERE id = ?';
  const result = await cassandraClient.execute(query, [userId], { prepare: true });
  if (result.rowLength > 0) {
    return result.rows[0];
  }
  return null;
}

// ============================================================================
// Get league join entry
// ============================================================================
async function getLeagueJoinEntry(userID, leagueID, joinMonth, l_id) {
  if (userID == null || joinMonth == null) {
    return null;
  }

  if (l_id) {
    try {
      const l_idStr = l_id.toString().toLowerCase();
      const queryById = DB_QUERIES.SELECT_LEAGUE_JOIN_BY_ID;
      const resultById = await cassandraClient.execute(queryById, [l_id], { prepare: true });
      
      if (resultById.rowLength > 0) {
        const row = resultById.rows[0];
        const rowId = row.id ? row.id.toString().toLowerCase() : '';
        
        if (rowId === l_idStr) {
          const statusStr = (row.status || '').toLowerCase();
          const isActiveStatus = !row.status ||
            statusStr === 'pending' ||
            statusStr === 'matched' ||
            statusStr === 'active' ||
            statusStr === GAME_STATUS.MATCHED?.toLowerCase() ||
            statusStr === GAME_STATUS.ACTIVE?.toLowerCase();
          
          if (isActiveStatus) {
            const userIdMatch = !userID || !row.user_id || row.user_id.toString() === userID.toString();
            const leagueIdMatch = !leagueID || !row.league_id || row.league_id.toString() === leagueID.toString();
            
            if (userIdMatch && leagueIdMatch) {
              return {
                UserID: row.user_id ? String(row.user_id) : userID,
                OpponentUserID: row.opponent_user_id,
                OpponentLeagueID: row.opponent_league_id,
                JoinedAt: row.joined_at,
                MatchPairID: { toString: () => row.match_pair_id ? row.match_pair_id.toString() : '' },
                TurnID: row.turn_id,
                LeagueID: row.league_id ? String(row.league_id) : '',
                ID: row.id,
                status: row.status
              };
            }
          }
        }
      }
    } catch (err) {}
  }

  const candidateStatusIds = ['1', '2', '3', '4'];
  const query = 'SELECT opponent_user_id, opponent_league_id, joined_at, match_pair_id, league_id, turn_id, id, status FROM league_joins WHERE user_id = ? AND status_id = ? AND join_month = ?';

  for (const statusId of candidateStatusIds) {
    try {
      const result = await cassandraClient.execute(query, [userID, statusId, joinMonth], { prepare: true });

      if (l_id) {
        const l_idStr = l_id.toString().toLowerCase();
        const rowById = result.rows.find(r => {
          const rowId = r.id ? r.id.toString().toLowerCase() : '';
          return rowId === l_idStr;
        });

        if (rowById) {
          const statusStr = (rowById.status || '').toLowerCase();
          const statusMatch = !rowById.status ||
            statusStr === 'pending' ||
            statusStr === 'matched' ||
            statusStr === 'active' ||
            statusStr === GAME_STATUS.MATCHED?.toLowerCase() ||
            statusStr === GAME_STATUS.ACTIVE?.toLowerCase();

          if (statusMatch) {
            if (leagueID) {
              const rowLeagueId = rowById.league_id ? rowById.league_id.toString() : '';
              if (rowLeagueId && rowLeagueId !== leagueID.toString()) {
              }
            }

            return {
              UserID: userID,
              OpponentUserID: rowById.opponent_user_id,
              OpponentLeagueID: rowById.opponent_league_id,
              JoinedAt: rowById.joined_at,
              MatchPairID: { toString: () => rowById.match_pair_id ? rowById.match_pair_id.toString() : '' },
              TurnID: rowById.turn_id,
              LeagueID: rowById.league_id,
              ID: rowById.id,
              status: rowById.status
            };
          }
        }
      }

      if (leagueID) {
        const leagueIDStr = leagueID.toString();
        const row = result.rows.find(r => {
          const rowLeagueId = r.league_id ? r.league_id.toString() : '';
          const rowId = r.id ? r.id.toString().toLowerCase() : '';
          const l_idStr = l_id ? l_id.toString().toLowerCase() : '';
          const leagueIdMatch = rowLeagueId === leagueIDStr;
          const idMatch = !l_id || rowId === l_idStr;
          const statusStr = (r.status || '').toLowerCase();
          const statusMatch = !r.status ||
            statusStr === 'pending' ||
            statusStr === 'matched' ||
            statusStr === 'active' ||
            statusStr === GAME_STATUS.MATCHED?.toLowerCase() ||
            statusStr === GAME_STATUS.ACTIVE?.toLowerCase();

          return leagueIdMatch && idMatch && statusMatch;
        });

        if (row) {
          return {
            UserID: userID,
            OpponentUserID: row.opponent_user_id,
            OpponentLeagueID: row.opponent_league_id,
            JoinedAt: row.joined_at,
            MatchPairID: { toString: () => row.match_pair_id ? row.match_pair_id.toString() : '' },
            TurnID: row.turn_id,
            LeagueID: row.league_id,
            ID: row.id,
            status: row.status
          };
        }
      }

      if (!l_id && !leagueID && result.rows.length > 0) {
        const firstValidRow = result.rows.find(r => {
          const statusStr = (r.status || '').toLowerCase();
          const statusMatch = !r.status ||
            statusStr === 'pending' ||
            statusStr === 'matched' ||
            statusStr === 'active' ||
            statusStr === GAME_STATUS.MATCHED?.toLowerCase() ||
            statusStr === GAME_STATUS.ACTIVE?.toLowerCase();
          return statusMatch;
        });

        if (firstValidRow) {
          return {
            UserID: userID,
            OpponentUserID: firstValidRow.opponent_user_id,
            OpponentLeagueID: firstValidRow.opponent_league_id,
            JoinedAt: firstValidRow.joined_at,
            MatchPairID: { toString: () => firstValidRow.match_pair_id ? firstValidRow.match_pair_id.toString() : '' },
            TurnID: firstValidRow.turn_id,
            LeagueID: firstValidRow.league_id,
            ID: firstValidRow.id,
            status: firstValidRow.status
          };
        }
      }
    } catch (err) {
      continue;
    }
  }

  return null;
}

// ============================================================================
// Get user pieces current state
// ============================================================================
async function getUserPiecesCurrentState(gameID, userID) {
  if (gameID == null || userID == null) {
    return [];
  }
  const query = 'SELECT * FROM game_pieces WHERE game_id = ? AND user_id = ?';
  const result = await cassandraClient.execute(query, [gameID, userID], { prepare: true });
  return result.rows;
}

// ============================================================================
// Enhance pieces with comprehensive data
// ============================================================================
function enhancePiecesWithComprehensiveData(pieces, gameID, userID) {
  return pieces.map(p => ({ ...p, enhanced: true }));
}

// ============================================================================
// Get dice ID
// ============================================================================
async function getDiceID(gameID, userID) {
  if (gameID == null || userID == null) {
    return null;
  }
  const query = 'SELECT dice_id FROM dice_rolls_lookup WHERE game_id = ? AND user_id = ? LIMIT 1';
  const result = await cassandraClient.execute(query, [gameID, userID], { prepare: true });
  if (result.rowLength > 0) {
    return result.rows[0].dice_id ? result.rows[0].dice_id.toString() : '';
  }
  return '';
}

// ============================================================================
// Update match pair status
// ============================================================================
async function updateMatchPairStatus(matchPairID, newStatus) {
  if (matchPairID == null) {
    return;
  }
  const query = 'UPDATE match_pairs SET status = ?, updated_at = ? WHERE id = ?';
  await cassandraClient.execute(query, [newStatus, new Date().toISOString(), matchPairID], { prepare: true });
}

// ============================================================================
// Get opponent league join status
// ============================================================================
async function getOpponentLeagueJoinStatus(opponentUserID, matchPairID, joinMonth) {
  if (!opponentUserID || !matchPairID || !joinMonth) {
    return null;
  }
  
  try {
    const matchPairQuery = 'SELECT user1_id, user2_id, user1_data, user2_data FROM match_pairs WHERE id = ?';
    const matchPairResult = await cassandraClient.execute(matchPairQuery, [matchPairID], { prepare: true });
    
    if (matchPairResult.rowLength > 0) {
      const matchPair = matchPairResult.rows[0];
      const user1Id = matchPair.user1_id ? matchPair.user1_id.toString() : '';
      const user2Id = matchPair.user2_id ? matchPair.user2_id.toString() : '';
      const user1EntryId = matchPair.user1_data ? matchPair.user1_data.toString() : '';
      const user2EntryId = matchPair.user2_data ? matchPair.user2_data.toString() : '';
      const opponentUserIDStr = opponentUserID.toString();
      
      let entryId = null;
      if (user1Id === opponentUserIDStr && user1EntryId) {
        entryId = user1EntryId;
      } else if (user2Id === opponentUserIDStr && user2EntryId) {
        entryId = user2EntryId;
      }
      
      if (entryId) {
        try {
          const entryResult = await cassandraClient.execute(DB_QUERIES.SELECT_LEAGUE_JOIN_BY_ID, [entryId], { prepare: true });
          if (entryResult.rowLength > 0) {
            const entryRow = entryResult.rows[0];
            return entryRow.status ? entryRow.status.toLowerCase() : null;
          }
        } catch (err) {}
      }
    }
  } catch (err) {}
  
  const candidateStatusIds = ['1', '2', '3', '4'];
  const query = 'SELECT status FROM league_joins WHERE user_id = ? AND status_id = ? AND join_month = ? AND match_pair_id = ?';
  
  for (const statusId of candidateStatusIds) {
    try {
      const result = await cassandraClient.execute(query, [opponentUserID, statusId, joinMonth, matchPairID], { prepare: true });
      if (result.rowLength > 0) {
        const row = result.rows[0];
        return row.status ? row.status.toLowerCase() : null;
      }
    } catch (err) {
      continue;
    }
  }
  
  return null;
}

// ============================================================================
// Inserts or updates entry in league_joins_by_id table for fast lookups
// ============================================================================
async function upsertLeagueJoinById(id, joinedAt, userId, leagueId, opponentUserId = null, status = 'pending', extraData = null, options = {}) {
  if (!id || !joinedAt || !userId) {
    return;
  }
  try {
    const now = new Date();
    const joinMonth = options.joinMonth || getCurrentMonth(joinedAt);
    const entryFee = options.entryFee || null;
    const inviteCode = options.inviteCode || null;
    const matchPairId = options.matchPairId || null;
    const opponentLeagueId = options.opponentLeagueId || null;
    const rIp = options.rIp || null;
    const role = options.role || null;
    const statusId = options.statusId || '1';
    const turnId = options.turnId || null;
    
    await cassandraClient.execute(DB_QUERIES.INSERT_LEAGUE_JOIN_BY_ID, [
      id, entryFee, extraData, inviteCode, joinMonth, joinedAt, leagueId, 
      matchPairId, opponentLeagueId, opponentUserId, rIp, role, status, 
      statusId, turnId, now, userId
    ], { prepare: true });
  } catch (err) {}
}

// ============================================================================
// Updates opponent_user_id, match_pair_id, turn_id, opponent_league_id and status in league_joins_by_id table
// ============================================================================
async function updateLeagueJoinById(id, opponentUserId, status, options = {}) {
  if (!id) {
    return;
  }
  try {
    const now = new Date();
    const matchPairId = options.matchPairId || null;
    const turnId = options.turnId || null;
    const opponentLeagueId = options.opponentLeagueId || null;
    const statusId = options.statusId || null;
    
    await cassandraClient.execute(DB_QUERIES.UPDATE_LEAGUE_JOIN_BY_ID, [
      opponentUserId, opponentLeagueId, matchPairId, turnId, status, statusId, now, id
    ], { prepare: true });
  } catch (err) {}
}

// ============================================================================
// Updates only status and status_id in league_joins_by_id table (preserves opponent_user_id)
// ============================================================================
async function updateLeagueJoinByIdStatusOnly(id, status, statusId = null) {
  if (!id) {
    return;
  }
  try {
    const now = new Date();
    await cassandraClient.execute(DB_QUERIES.UPDATE_LEAGUE_JOIN_BY_ID_STATUS_ONLY, [status, statusId, now, id], { prepare: true });
  } catch (err) {}
}

// ============================================================================
// Updates status to expired in league_joins_by_id table
// ============================================================================
async function updateLeagueJoinByIdExpired(id, status = 'expired', statusId = null) {
  if (!id) {
    return;
  }
  try {
    const now = new Date();
    await cassandraClient.execute(DB_QUERIES.UPDATE_LEAGUE_JOIN_BY_ID_EXPIRED, [status, statusId, now, id], { prepare: true });
  } catch (err) {}
}

module.exports = {
  getUserByMobile,
  getUserById,
  getLeagueJoinEntry,
  getUserPiecesCurrentState,
  enhancePiecesWithComprehensiveData,
  getDiceID,
  updateMatchPairStatus,
  getOpponentLeagueJoinStatus,
  upsertLeagueJoinById,
  updateLeagueJoinById,
  updateLeagueJoinByIdExpired,
  updateLeagueJoinByIdStatusOnly,
};
