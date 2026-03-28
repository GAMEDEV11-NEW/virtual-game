const { authenticateOpponent } = require('../../utils/authUtils');
const {
  getLeagueJoinEntry,
  getLudoPiecesFromMatch,
  enhancePiecesWithComprehensiveData,
  getDiceID,
  getOpponentLeagueJoinStatus
} = require('../../services/ludo/gameService');
const validateFields = require('../../utils/validateFields');
const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { GAME_STATUS, REDIS_KEYS, DB_QUERIES } = require('../../constants');
const mysqlClient = require('../../services/mysql/client');

// ============================================================================
// Handler constants
// ============================================================================

const REQUIRED_FIELDS = ['user_id', 'contest_id', 'l_id'];
const COMPLETED_VALUE = (GAME_STATUS.COMPLETED || 'completed').toLowerCase();
const SELECT_MATCH_STATUS = DB_QUERIES.LUDO_SELECT_MATCH_STATUS;

// ============================================================================
// Status helpers
// ============================================================================
function isCompletedStatus(status) {
  return (status || '').toLowerCase() === COMPLETED_VALUE;
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  return value.toISOString ? value.toISOString() : new Date(value).toISOString();
}

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim();
}

function hasValidOpponent(entry) {
  const opponentId = normalizeId(entry?.OpponentUserID).toLowerCase();
  if (!opponentId || opponentId === 'null' || opponentId === 'undefined') return false;
  return opponentId !== normalizeId(entry?.UserID).toLowerCase();
}

function sameNormalizedId(a, b) {
  return normalizeId(a) !== '' && normalizeId(a) === normalizeId(b);
}

function normalizeDiceValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0];
    if (first && typeof first === 'object' && first.dice_id) return String(first.dice_id);
    return normalizeDiceValue(first);
  }
  if (typeof value === 'object') {
    if (value.dice_id) return String(value.dice_id);
    if (value.id) return String(value.id);
    return null;
  }
  const normalized = normalizeId(value);
  return normalized || null;
}

function normalizePieceForResponse(piece, gameId, userId, index) {
  const item = piece && typeof piece === 'object' ? piece : {};
  const resolvedPieceId = normalizeId(item.piece_id || item.id);
  const pieceNoRaw = item.piece_no != null ? Number(item.piece_no) : (index + 1);
  const pieceNo = Number.isFinite(pieceNoRaw) && pieceNoRaw > 0 ? pieceNoRaw : (index + 1);
  const nowIso = new Date().toISOString();
  return {
    game_id: normalizeId(item.game_id) || normalizeId(gameId),
    user_id: Number.isFinite(Number(item.user_id)) ? Number(item.user_id) : Number(userId),
    move_number: Number.isFinite(Number(item.move_number)) ? Number(item.move_number) : 0,
    piece_id: resolvedPieceId || `piece_${pieceNo}`,
    player_id: normalizeId(item.player_id),
    from_pos_last: normalizeId(item.from_pos_last) || 'initial',
    to_pos_last: normalizeId(item.to_pos_last) || 'initial',
    piece_type: normalizeId(item.piece_type) || `piece_${pieceNo}`,
    captured_piece: normalizeId(item.captured_piece),
    created_at: normalizeId(item.created_at) || nowIso,
    updated_at: normalizeId(item.updated_at) || nowIso,
    enhanced: true
  };
}

function normalizePiecesForResponse(pieces, gameId, userId) {
  const arr = Array.isArray(pieces) ? pieces : [];
  const normalized = arr.map((piece, index) => normalizePieceForResponse(piece, gameId, userId, index));
  return normalized.slice(0, 4);
}

function hasFourRealPieces(pieces) {
  if (!Array.isArray(pieces) || pieces.length < 4) return false;
  const firstFour = pieces.slice(0, 4);
  return firstFour.every((piece) => {
    const id = normalizeId(piece?.piece_id || piece?.id);
    return !!id;
  });
}

function isLudoStateReadyForSuccess(entry, gameData) {
  const userReady = hasFourRealPieces(gameData?.userPieces);
  const opponentReady = hasFourRealPieces(gameData?.opponentPieces);
  const userDiceReady = !!normalizeDiceValue(gameData?.userDiceID);
  const opponentDiceReady = !!normalizeDiceValue(gameData?.opponentDiceID);
  const hasMatch = !!normalizeId(entry?.MatchPairID);
  const hasOpponent = hasValidOpponent(entry);

  return hasMatch && hasOpponent && userReady && opponentReady && userDiceReady && opponentDiceReady;
}

async function getParsedRedisObject(key) {
  try {
    const value = await redisClient.get(key);
    const parsed = safeParseRedisData(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function getContestJoinSnapshotFromRedis(userId, contestId, lId) {
  const normalizedUserId = normalizeId(userId);
  const normalizedContestId = normalizeId(contestId);
  const normalizedLid = normalizeId(lId);
  if (!normalizedUserId || !normalizedContestId) return null;

  const keysToTry = [];
  if (normalizedLid) {
    keysToTry.push(`contest_join:${normalizedUserId}:${normalizedContestId}:${normalizedLid}`);
  }
  keysToTry.push(`contest_join:${normalizedUserId}:${normalizedContestId}`);
  keysToTry.push(`contest_join:${normalizedUserId}`);

  for (const key of keysToTry) {
    const parsed = await getParsedRedisObject(key);
    if (parsed) return parsed;
  }

  // Fallback pattern scan to support mixed/legacy keys.
  try {
    const patternKeys = await redisClient.scan(`contest_join:${normalizedUserId}:${normalizedContestId}:*`, { count: 50 });
    for (const key of patternKeys) {
      const parsed = await getParsedRedisObject(key);
      if (parsed) return parsed;
    }
  } catch (_) {
  }

  return null;
}

function mapContestJoinSnapshotToEntry(snapshot, fallback = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    UserID: snapshot.user_id || fallback.user_id || '',
    OpponentUserID: snapshot.opponent_user_id || '',
    OpponentLeagueID: snapshot.opponent_league_id || '',
    JoinedAt: snapshot.joined_at || null,
    MatchPairID: snapshot.match_id || snapshot.match_pair_id || '',
    TurnID: snapshot.turn_id || null,
    status: snapshot.status || 'pending'
  };
}

async function hydrateEntryFromRedisMatch(entry, userId) {
  if (!entry) return entry;
  const matchPairID = normalizeId(entry.MatchPairID);
  if (!matchPairID) return entry;

  const match = await getParsedRedisObject(REDIS_KEYS.MATCH(matchPairID));
  if (!match) return entry;

  const normalizedUserId = normalizeId(userId);
  const user1 = normalizeId(match.user1_id);
  const user2 = normalizeId(match.user2_id);

  if (!normalizeId(entry.OpponentUserID)) {
    if (normalizedUserId && normalizedUserId === user1) {
      entry.OpponentUserID = user2 || entry.OpponentUserID;
    } else if (normalizedUserId && normalizedUserId === user2) {
      entry.OpponentUserID = user1 || entry.OpponentUserID;
    }
  }

  if (!entry.TurnID && match.turn) {
    entry.TurnID = match.turn;
  }

  return entry;
}


// ============================================================================
// Game pieces/dice retrieval
// ============================================================================
async function fetchGamePiecesAndDice(gameID, userID, opponentUserID) {
  let userPieces = [];
  let opponentPieces = [];
  let userDiceID = null;
  let opponentDiceID = null;
  let matchTurnId = null;

  const match = await getParsedRedisObject(REDIS_KEYS.MATCH(gameID));
  if (match) {
    const isUser1 = sameNormalizedId(userID, match.user1_id);
    const isUser2 = sameNormalizedId(userID, match.user2_id);

    if (isUser1 || isUser2) {
      const selfPrefix = isUser1 ? 'user1' : 'user2';
      const opponentPrefix = isUser1 ? 'user2' : 'user1';
      userPieces = Array.isArray(match[`${selfPrefix}_pieces`]) ? match[`${selfPrefix}_pieces`] : [];
      opponentPieces = Array.isArray(match[`${opponentPrefix}_pieces`]) ? match[`${opponentPrefix}_pieces`] : [];
      userDiceID = match[`${selfPrefix}_dice`] || null;
      opponentDiceID = match[`${opponentPrefix}_dice`] || null;
    }

    if (match.turn !== undefined && match.turn !== null) {
      matchTurnId = match.turn;
    }
  }

  userPieces = await ensureLudoPieces(gameID, userID, userPieces);
  opponentPieces = opponentUserID === userID
    ? userPieces
    : await ensureLudoPieces(gameID, opponentUserID, opponentPieces);

  if (!opponentDiceID && opponentUserID) {
    opponentDiceID = await getDiceID(gameID, opponentUserID);
  }
  if (!userDiceID) {
    userDiceID = await getDiceID(gameID, userID);
  }

  return {
    userPieces: Array.isArray(userPieces) ? userPieces : [],
    opponentPieces: Array.isArray(opponentPieces) ? opponentPieces : [],
    userDiceID,
    opponentDiceID,
    matchTurnId
  };
}

// ============================================================================
// Ludo piece bootstrap
// ============================================================================
async function ensureLudoPieces(gameID, userID, pieces) {
  if (!Array.isArray(pieces) || pieces.length === 0) {
    const fallbackPieces = await getLudoPiecesFromMatch(gameID, userID);
    return enhancePiecesWithComprehensiveData(Array.isArray(fallbackPieces) ? fallbackPieces : [], gameID, userID);
  }
  return enhancePiecesWithComprehensiveData(pieces, gameID, userID);
}

// ============================================================================
// Emit success response with game data
// ============================================================================
function emitOpponentResponseWithGameData(socket, entry, gameData) {
  const resolvedTurnId = normalizeId(entry.TurnID) || normalizeId(gameData.matchTurnId) || null;
  const gameId = normalizeId(entry.MatchPairID);
  const userId = normalizeId(entry.UserID);
  const opponentUserId = normalizeId(entry.OpponentUserID);
  const response = {
    status: 'success',
    user_id: userId,
    opponent_user_id: opponentUserId,
    opponent_league_id: entry.OpponentLeagueID ? String(entry.OpponentLeagueID) : '',
    joined_at: toIsoDate(entry.JoinedAt),
    game_id: gameId,
    user_pieces: normalizePiecesForResponse(gameData.userPieces, gameId, userId),
    opponent_pieces: normalizePiecesForResponse(gameData.opponentPieces, gameId, opponentUserId),
    user_dice: normalizeDiceValue(gameData.userDiceID),
    opponent_dice: normalizeDiceValue(gameData.opponentDiceID),
    pieces_status: 'active',
    turn_id: resolvedTurnId,
    start_time: toIsoDate(entry.JoinedAt),
    user_full_name: '',
    user_profile_data: '',
    opponent_full_name: '',
    opponent_profile_data: ''
  };

  socket.emit('opponent:response', response);
}

// ============================================================================
// Emit pending response
// ============================================================================
function emitPendingOpponentResponse(socket, entry = {}, message = 'Waiting for opponent match...') {
  socket.emit('opponent:response', {
    status: 'pending',
    user_id: entry.UserID ? String(entry.UserID) : '',
    opponent_user_id: '',
    opponent_league_id: '',
    joined_at: entry.JoinedAt ? toIsoDate(entry.JoinedAt) : null,
    game_id: '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'pending',
    turn_id: entry.TurnID ?? null,
    message
  });
}

function emitCompletedOpponentResponse(socket, payload = {}) {
  socket.emit('opponent:response', {
    status: 'completed',
    user_id: payload.user_id ? String(payload.user_id) : '',
    opponent_user_id: payload.opponent_user_id ? String(payload.opponent_user_id) : '',
    opponent_league_id: payload.opponent_league_id ? String(payload.opponent_league_id) : '',
    joined_at: payload.joined_at || null,
    game_id: payload.game_id ? String(payload.game_id) : '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'completed',
    turn_id: payload.turn_id ?? null,
    message: 'Game has been completed'
  });
}

function emitExpiredAndDisconnect(socket, payload = {}) {
  socket.emit('opponent:response', {
    status: 'expired',
    user_id: payload.user_id ? String(payload.user_id) : '',
    opponent_user_id: '',
    opponent_league_id: '',
    joined_at: payload.joined_at || null,
    game_id: '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'expired',
    turn_id: null,
    message: 'Entry expired'
  });

  setTimeout(() => {
    try {
      socket.disconnect(true);
    } catch (_) {
    }
  }, 50);
}

// ============================================================================
// Locate terminal joins (completed/expired) with completed priority
// ============================================================================
async function findTerminalEntry({ userId, leagueJoinId }) {
  const completed = COMPLETED_VALUE;
  const expired = 'expired';

  if (leagueJoinId) {
    try {
      const [rows] = await mysqlClient.execute(
        `
          SELECT l_id, user_id, opponent_user_id, opponent_league_id, joined_at, match_id, turn_id, status
          FROM ludo_game
          WHERE l_id = ?
            AND LOWER(status) IN (?, ?)
          ORDER BY
            CASE WHEN LOWER(status) = ? THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `,
        [leagueJoinId, completed, expired, completed]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const entryRow = rows[0];
        const sameUser = !userId || !entryRow.user_id || normalizeId(entryRow.user_id) === normalizeId(userId);
        if (sameUser) return entryRow;
      }
    } catch (_) {
    }
  }

  try {
    const normalizedLid = normalizeId(leagueJoinId);
    const hasRequestedLid = normalizedLid.length > 0;
    const [rows] = await mysqlClient.execute(
      `
        SELECT l_id, user_id, opponent_user_id, opponent_league_id, joined_at, match_id, turn_id, status
        FROM ludo_game
        WHERE user_id = ?
          AND LOWER(status) IN (?, ?)
          AND (? = 0 OR l_id = ?)
        ORDER BY
          CASE WHEN LOWER(status) = ? THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `,
      [userId, completed, expired, hasRequestedLid ? 1 : 0, normalizedLid, completed]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0];
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Determine if match or league joins are completed
// ============================================================================
async function isMatchCompleted(entry, matchPairID) {
  if (!matchPairID) {
    return false;
  }

  try {
    const [rows] = await mysqlClient.execute(SELECT_MATCH_STATUS, [matchPairID]);
    if (Array.isArray(rows) && rows.length > 0) {
      const matchStatus = rows[0]?.status;
      if (isCompletedStatus(matchStatus)) {
        return true;
      }
    }
  } catch (_) {
  }

  const userCompleted = isCompletedStatus(entry.status);
  if (userCompleted) {
    return true;
  }

  if (!hasValidOpponent(entry)) {
    return false;
  }

  try {
    const opponentStatus = await getOpponentLeagueJoinStatus(entry.OpponentUserID, matchPairID);
    if (isCompletedStatus(opponentStatus)) {
      return true;
    }
  } catch (_) {
  }

  return false;
}

// ============================================================================
// Main handler
// ============================================================================
async function handleCheckOpponent(socket, data) {
  const payload = await authenticateOpponent(socket, data, 'opponent:response');
  if (!payload) {
    return;
  }
  if (!validateFields(socket, payload, REQUIRED_FIELDS, 'opponent:response')) {
    return;
  }

  const { user_id, contest_id, l_id } = payload;

  // Redis-first fast path to reduce DB load for repeated polling.
  const contestSnapshot = await getContestJoinSnapshotFromRedis(user_id, contest_id, l_id);
  let entry = mapContestJoinSnapshotToEntry(contestSnapshot, { user_id, contest_id, l_id });

  if (!(entry && normalizeId(entry.MatchPairID) && hasValidOpponent(entry))) {
    // DB fallback when redis snapshot is missing/incomplete.
    entry = await getLeagueJoinEntry(user_id, contest_id, '', l_id);
  }

  if (!entry) {
    const terminalRow = await findTerminalEntry({ userId: user_id, leagueJoinId: l_id });
    const terminalStatus = normalizeId(terminalRow?.status).toLowerCase();

    if (terminalRow && isCompletedStatus(terminalStatus)) {
      emitCompletedOpponentResponse(socket, {
        user_id,
        opponent_user_id: terminalRow.opponent_user_id || '',
        opponent_league_id: terminalRow.opponent_league_id ? terminalRow.opponent_league_id.toString() : '',
        joined_at: terminalRow.joined_at ? toIsoDate(terminalRow.joined_at) : null,
        game_id: terminalRow.match_id ? terminalRow.match_id.toString() : '',
        turn_id: terminalRow.turn_id
      });
      return;
    }

    if (terminalRow && terminalStatus === 'expired') {
      emitExpiredAndDisconnect(socket, {
        user_id,
        joined_at: terminalRow.joined_at ? toIsoDate(terminalRow.joined_at) : null
      });
      return;
    }

    emitPendingOpponentResponse(socket, { UserID: user_id }, 'Waiting for opponent match...');
    return;
  }

  entry = await hydrateEntryFromRedisMatch(entry, user_id);
  const entryStatus = normalizeId(entry.status).toLowerCase();
  if (entryStatus === 'expired') {
    emitExpiredAndDisconnect(socket, {
      user_id: entry.UserID ? String(entry.UserID) : String(user_id || ''),
      joined_at: entry.JoinedAt ? toIsoDate(entry.JoinedAt) : null
    });
    return;
  }

  const normalizedMatchPairId = normalizeId(entry.MatchPairID);
  if (!entry.UserID || !normalizedMatchPairId) {
    const waitMessage = entryStatus === 'matched'
      ? 'Matched found, preparing game...'
      : 'Entry data incomplete, waiting for match...';
    emitPendingOpponentResponse(socket, entry, waitMessage);
    return;
  }

  const matchPairID = normalizedMatchPairId;
  const isCompleted = await isMatchCompleted(entry, matchPairID);
  if (isCompleted) {
    emitCompletedOpponentResponse(socket, {
      user_id: entry.UserID ? String(entry.UserID) : '',
      opponent_user_id: entry.OpponentUserID ? String(entry.OpponentUserID) : '',
      opponent_league_id: entry.OpponentLeagueID ? String(entry.OpponentLeagueID) : '',
      joined_at: toIsoDate(entry.JoinedAt),
      game_id: matchPairID,
      turn_id: entry.TurnID
    });
    return;
  }

  if (!hasValidOpponent(entry)) {
    emitPendingOpponentResponse(socket, entry);
    return;
  }

  const gameData = await fetchGamePiecesAndDice(matchPairID, entry.UserID, entry.OpponentUserID);
  if (!isLudoStateReadyForSuccess(entry, gameData)) {
    emitPendingOpponentResponse(socket, entry, 'Matched found, preparing game...');
    return;
  }

  emitOpponentResponseWithGameData(socket, entry, gameData);
}

// ============================================================================
// Socket.io registration
// ============================================================================
function registerCheckOpponentHandler(_io, socket) {
  socket.removeAllListeners('check:opponent');
  socket.on('check:opponent', async (request) => {
    await handleCheckOpponent(socket, request);
  });
}

module.exports = { registerCheckOpponentHandler };
