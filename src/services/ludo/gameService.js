const mysqlClient = require('../mysql/client');
const { DB_QUERIES } = require('../../constants');

const ACTIVE_LUDO_STATUSES = new Set(['pending', 'matched', 'active']);

function toStatusId(status, fallback = null) {
  const normalized = (status || '').toString().toLowerCase();
  if (normalized === 'pending') return '1';
  if (normalized === 'matched') return '2';
  if (normalized === 'active') return '3';
  if (normalized === 'completed') return '4';
  if (normalized === 'cancelled') return '5';
  if (normalized === 'expired') return '6';
  return fallback;
}

function mapLudoEntryRow(row, fallbackUserId = null) {
  if (!row) return null;
  return {
    UserID: row.user_id != null ? String(row.user_id) : fallbackUserId,
    OpponentUserID: row.opponent_user_id,
    OpponentLeagueID: row.opponent_league_id,
    JoinedAt: row.joined_at,
    MatchPairID: row.match_id ? String(row.match_id) : '',
    TurnID: row.turn_id,
    LeagueID: row.league_id != null ? String(row.league_id) : '',
    ID: row.l_id,
    status: row.status
  };
}

function toJoinDay(joinedAt) {
  const d = joinedAt ? new Date(joinedAt) : new Date();
  return d.toISOString().slice(0, 10);
}

function buildPiecesFromIds(pieceIds = []) {
  return pieceIds
    .filter((id) => !!id)
    .map((id, index) => ({
      piece_id: String(id),
      id: String(id),
      piece_no: index + 1,
      position: 0,
      status: 'home'
    }));
}

// ============================================================================
// Get user by mobile number
// ============================================================================
async function getUserByMobile(mobileNo) {
  if (mobileNo == null) {
    return null;
  }
  try {
    const [rows] = await mysqlClient.execute(
      `SELECT id, mobile_no, full_name, status, language_code, profile_data
       FROM users
       WHERE mobile_no = ?
       LIMIT 1`,
      [mobileNo]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
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
  try {
    const [rows] = await mysqlClient.execute(
      `SELECT id, mobile_no, full_name, status, language_code, profile_data
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }
  } catch (err) {
    return null;
  }
  return null;
}

// ============================================================================
// Get league join entry
// ============================================================================
async function getLeagueJoinEntry(userID, leagueID, _joinMonth, l_id) {
  if (userID == null) {
    return null;
  }

  if (l_id) {
    try {
      const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_JOIN_BY_LID, [l_id]);
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0];
        const status = (row.status || '').toLowerCase();
        const isActive = ACTIVE_LUDO_STATUSES.has(status);
        const userIdMatch = !userID || !row.user_id || row.user_id.toString() === userID.toString();
        const contestMatch = !leagueID || !row.contest_id || row.contest_id.toString() === leagueID.toString();
        if (isActive && userIdMatch && contestMatch) {
          return mapLudoEntryRow(row, userID);
        }
      }
    } catch (err) {}
  }
  if (!leagueID) return null;

  try {
    const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_JOIN_BY_USER_CONTEST, [userID, leagueID]);
    if (Array.isArray(rows) && rows.length > 0) {
      return mapLudoEntryRow(rows[0], userID);
    }
  } catch (err) {}

  return null;
}

// ============================================================================
// Get user pieces current state
// ============================================================================
async function getUserPiecesCurrentState(gameID, userID) {
  return getLudoPiecesFromMatch(gameID, userID);
}

// ============================================================================
// Get ludo pieces from ludo_game piece-id columns (no game_pieces fallback)
// ============================================================================
async function getLudoPiecesFromMatch(gameID, userID) {
  if (gameID == null || userID == null) {
    return [];
  }

  const query = `
    SELECT
      user_id,
      opponent_user_id,
      user_piece_1_id, user_piece_2_id, user_piece_3_id, user_piece_4_id,
      opponent_piece_1_id, opponent_piece_2_id, opponent_piece_3_id, opponent_piece_4_id
    FROM ludo_game
    WHERE match_id = ? AND is_deleted = 0 AND (user_id = ? OR opponent_user_id = ?)
    ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `;

  try {
    const [rows] = await mysqlClient.execute(query, [gameID, userID, userID, userID]);
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }

    const row = rows[0];
    const useUserPieceCols = row.user_id != null && row.user_id.toString() === userID.toString();
    const ids = useUserPieceCols
      ? [row.user_piece_1_id, row.user_piece_2_id, row.user_piece_3_id, row.user_piece_4_id]
      : [row.opponent_piece_1_id, row.opponent_piece_2_id, row.opponent_piece_3_id, row.opponent_piece_4_id];

    return buildPiecesFromIds(ids);
  } catch (err) {
    return [];
  }
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

  const query = `
    SELECT
      user_id,
      opponent_user_id,
      user_dice_id,
      opponent_dice_id
    FROM ludo_game
    WHERE match_id = ? AND is_deleted = 0 AND (user_id = ? OR opponent_user_id = ?)
    ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `;

  try {
    const [rows] = await mysqlClient.execute(query, [gameID, userID, userID, userID]);
    if (!Array.isArray(rows) || rows.length === 0) {
      return '';
    }

    const row = rows[0];
    const isPrimaryUser = row.user_id != null && row.user_id.toString() === userID.toString();
    const diceId = isPrimaryUser ? row.user_dice_id : row.opponent_dice_id;
    return diceId ? diceId.toString() : '';
  } catch (err) {
    return '';
  }
}

// ============================================================================
// Update match pair status
// ============================================================================
async function updateMatchPairStatus(matchPairID, newStatus) {
  if (matchPairID == null) {
    return;
  }
  const statusId = toStatusId(newStatus);
  await mysqlClient.execute(DB_QUERIES.LUDO_UPDATE_STATUS_BY_MATCH, [newStatus, statusId, matchPairID]);
}

// ============================================================================
// Get opponent league join status
// ============================================================================
async function getOpponentLeagueJoinStatus(opponentUserID, matchPairID, _joinMonth) {
  if (!opponentUserID || !matchPairID) {
    return null;
  }

  try {
    const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_OPPONENT_STATUS_BY_MATCH, [opponentUserID, matchPairID]);
    if (Array.isArray(rows) && rows.length > 0) {
      const status = rows[0]?.status;
      return status ? status.toLowerCase() : null;
    }
  } catch (err) {}

  return null;
}

// ============================================================================
// Update entry in ludo_game table by l_id
// ============================================================================
async function upsertLeagueJoinById(id, joinedAt, userId, leagueId, opponentUserId = null, status = 'pending', extraData = null, options = {}) {
  if (!id || !joinedAt || !userId) {
    return;
  }
  try {
    const matchPairId = options.matchPairId || null;
    const turnId = options.turnId || null;
    const opponentLeagueId = options.opponentLeagueId || null;
    const statusId = options.statusId || toStatusId(status, '1');
    const contestId = options.contestId || leagueId;
    const joinDay = options.joinDay || toJoinDay(joinedAt);

    await mysqlClient.execute(DB_QUERIES.LUDO_UPSERT_JOIN_BY_LID, [
      id,
      userId,
      contestId,
      leagueId,
      joinedAt,
      joinDay,
      status,
      statusId,
      opponentUserId,
      opponentLeagueId,
      matchPairId,
      turnId
    ]);
  } catch (err) {}
}

// ============================================================================
// Updates opponent_user_id, match_id, turn_id, opponent_league_id and status in ludo_game table
// ============================================================================
async function updateLeagueJoinById(id, opponentUserId, status, options = {}) {
  if (!id) {
    return;
  }
  try {
    const matchPairId = options.matchPairId || null;
    const turnId = options.turnId || null;
    const opponentLeagueId = options.opponentLeagueId || null;
    const statusId = options.statusId || toStatusId(status);

    await mysqlClient.execute(DB_QUERIES.LUDO_UPDATE_JOIN_BY_LID, [
      opponentUserId, opponentLeagueId, matchPairId, turnId, status, statusId, id
    ]);
  } catch (err) {}
}

// ============================================================================
// Updates only status and status_id in ludo_game table (preserves opponent_user_id)
// ============================================================================
async function updateLeagueJoinByIdStatusOnly(id, status, statusId = null) {
  if (!id) {
    return;
  }
  try {
    const resolvedStatusId = statusId || toStatusId(status);
    await mysqlClient.execute(DB_QUERIES.LUDO_UPDATE_JOIN_STATUS_ONLY_BY_LID, [status, resolvedStatusId, id]);
  } catch (err) {}
}

// ============================================================================
// Updates status to expired in ludo_game table
// ============================================================================
async function updateLeagueJoinByIdExpired(id, status = 'expired', statusId = null) {
  if (!id) {
    return;
  }
  try {
    const resolvedStatusId = statusId || toStatusId(status);
    await mysqlClient.execute(DB_QUERIES.LUDO_UPDATE_JOIN_EXPIRED_BY_LID, [status, resolvedStatusId, id]);
  } catch (err) {}
}

module.exports = {
  getUserByMobile,
  getUserById,
  getLeagueJoinEntry,
  getLudoPiecesFromMatch,
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
