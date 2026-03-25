const DEFAULT_HOME_POSITION = 57;

// ============================================================================
// Converts position to number or string
// ============================================================================
function toNumberOrStringPosition(pos) {
  if (pos === null || pos === undefined) return 'initial';
  const n = Number(pos);
  return Number.isNaN(n) ? String(pos) : n;
}

// ============================================================================
// Normalizes piece object
// ============================================================================
function normalizePiece(piece) {
  return {
    id: piece.piece_id ?? piece.pieceId ?? piece.id,
    pos: toNumberOrStringPosition(
      piece.to_pos_last ?? piece.position ?? piece.pos
    ),
    type: piece.piece_type ?? piece.type ?? '',
  };
}

// ============================================================================
// Denormalizes piece object
// ============================================================================
function denormalizePiece(piece, original) {
  const result = { ...original };
  if ('to_pos_last' in original) result.to_pos_last = piece.pos;
  else if ('position' in original) result.position = piece.pos;
  else result.pos = piece.pos;
  if ('piece_type' in original) result.piece_type = piece.type;
  else if ('type' in original) result.type = piece.type;
  return result;
}

// ============================================================================
// Checks if square is safe
// ============================================================================
function isSafeSquare(square, safeSquares) {
  const val = Number(square);
  if (Number.isNaN(val)) return false;
  return Array.isArray(safeSquares) && safeSquares.includes(val);
}

// ============================================================================
// Evaluates a move against current board state
// ============================================================================
function evaluateMoveAgainstBoard({
  fromPos,
  toPos,
  playerPieces,
  opponentPieces,
  safeSquares = [],
  homePosition = DEFAULT_HOME_POSITION,
  movedPieceId,
}) {
  const from = Number(fromPos);
  const to = Number(toPos);

  const normalizedPlayer = (playerPieces || []).map(normalizePiece);
  const normalizedOpponent = (opponentPieces || []).map(normalizePiece);

  const isOvershoot = Number.isFinite(to) && to > homePosition;
  const isExactHomeReach = Number.isFinite(to) && to === homePosition && Number.isFinite(from) && from < homePosition;

  const ownOnTo = normalizedPlayer.filter(p => p.pos === to);
  const oppOnTo = normalizedOpponent.filter(p => p.pos === to);

  const opponentBlock = oppOnTo.length >= 2;
  const squareIsSafe = isSafeSquare(to, safeSquares);
  const isKill = oppOnTo.length === 1 && !squareIsSafe && !opponentBlock && !isExactHomeReach;
  const killedPieceId = isKill ? oppOnTo[0].id : null;

  let movedId = movedPieceId ?? null;
  if (!movedId) {
    if (Number.isFinite(from)) {
      const candidate = normalizedPlayer.find(p => Number(p.pos) === from);
      movedId = candidate ? candidate.id : null;
    } else {
      const candidate = normalizedPlayer.find(p => String(p.pos) === String(fromPos));
      movedId = candidate ? candidate.id : null;
    }
  }

  const updatedPlayer = normalizedPlayer.map(p =>
    movedId && p.id === movedId
      ? { ...p, pos: to }
      : p
  );

  let updatedOpponent = normalizedOpponent;
  if (isKill && killedPieceId) {
    updatedOpponent = normalizedOpponent.map(p =>
      p.id === killedPieceId ? { ...p, pos: 'initial' } : p
    );
  }

  const finalPlayerPieces = updatedPlayer.map((p, idx) => denormalizePiece(p, playerPieces[idx] || {}));
  const finalOpponentPieces = updatedOpponent.map((p, idx) => denormalizePiece(p, opponentPieces[idx] || {}));

  return {
    isValid: !isOvershoot,
    isOvershoot,
    isExactHomeReach,
    occupancy: {
      ownCount: ownOnTo.length,
      opponentCount: oppOnTo.length,
      isOpponentBlock: opponentBlock,
      isSafeSquare: squareIsSafe,
    },
    kill: { isKill, killedPieceId },
    updated: {
      playerPieces: finalPlayerPieces,
      opponentPieces: finalOpponentPieces,
    },
  };
}

const KILL_POSITION = {
  CHECK_KILL_POSITION: [
    { user_position: '2', opponent_position: '28'},
    { user_position: '3', opponent_position: '29'},
    { user_position: '4', opponent_position: '30'},
    { user_position: '5', opponent_position: '31'},
    { user_position: '6', opponent_position: '32'},
    { user_position: '7', opponent_position: '33'},
    { user_position: '8', opponent_position: '34'},
    { user_position: '10', opponent_position: '36'},
    { user_position: '11', opponent_position: '37'},
    { user_position: '12', opponent_position: '38'},
    { user_position: '13', opponent_position: '39'},
    { user_position: '15', opponent_position: '41'},
    { user_position: '16', opponent_position: '42'},
    { user_position: '17', opponent_position: '43'},
    { user_position: '18', opponent_position: '44'},
    { user_position: '19', opponent_position: '45'},
    { user_position: '20', opponent_position: '46'},
    { user_position: '21', opponent_position: '47'},
    { user_position: '23', opponent_position: '49'},
    { user_position: '24', opponent_position: '50'},
    { user_position: '25', opponent_position: '51'},
    { user_position: '26', opponent_position: '52'},
    { user_position: '27', opponent_position: '1'},
    { user_position: '28', opponent_position: '2'},
    { user_position: '29', opponent_position: '3'},
    { user_position: '30', opponent_position: '4'},
    { user_position: '31', opponent_position: '5'},
    { user_position: '32', opponent_position: '6'},
    { user_position: '33', opponent_position: '7'},
    { user_position: '34', opponent_position: '8'},
    { user_position: '36', opponent_position: '10'},
    { user_position: '37', opponent_position: '11'},
    { user_position: '38', opponent_position: '12'},
    { user_position: '39', opponent_position: '13'},
    { user_position: '41', opponent_position: '15'},
    { user_position: '42', opponent_position: '16'},
    { user_position: '43', opponent_position: '17'},
    { user_position: '44', opponent_position: '18'},
    { user_position: '45', opponent_position: '19'},
    { user_position: '46', opponent_position: '20'},
    { user_position: '47', opponent_position: '21'},
    { user_position: '49', opponent_position: '23'},
    { user_position: '50', opponent_position: '24'},
    { user_position: '51', opponent_position: '25'},
  ],
};

// ============================================================================
// Evaluates kill by mapping
// ============================================================================
function evaluateKillByMapping(
  userToPos,
  opponentPieces,
  mapping = KILL_POSITION.CHECK_KILL_POSITION,
  safeSquares = [],
  homePosition = DEFAULT_HOME_POSITION
) {
  const toNum = Number(userToPos);
  const toStr = String(userToPos);
  
  if (Number.isFinite(toNum) && toNum === homePosition) {
    return { isKill: false, killedOpponentPieceId: null, killedOpponentPieceIds: [], killedOpponentSquare: null };
  }
  
  const row = (mapping || []).find(r => String(r.user_position) === toStr);
  
  if (!row) {
    return { isKill: false, killedOpponentPieceId: null, killedOpponentPieceIds: [], killedOpponentSquare: null };
  }
  
  const targetSquareNum = Number(row.opponent_position);
  const targetSquareStr = String(row.opponent_position);
  
  if (isSafeSquare(targetSquareNum, safeSquares)) {
    return { isKill: false, killedOpponentPieceId: null, killedOpponentPieceIds: [], killedOpponentSquare: null };
  }
  
  const normalizedOpponent = (opponentPieces || []).map(normalizePiece);
  const opponentsOnTarget = normalizedOpponent.filter(p => String(p.pos) === targetSquareStr);
  
  if (opponentsOnTarget.length === 0) {
    return { isKill: false, killedOpponentPieceId: null, killedOpponentPieceIds: [], killedOpponentSquare: null };
  }
  
  const killedIds = opponentsOnTarget.map(p => p.id).filter(id => id !== null);
  const isKill = killedIds.length > 0;
  const killedId = killedIds.length > 0 ? killedIds[0] : null;
  
  return { isKill, killedOpponentPieceId: killedId, killedOpponentPieceIds: killedIds, killedOpponentSquare: targetSquareStr };
}

module.exports = {
  evaluateMoveAgainstBoard,
  KILL_POSITION,
  evaluateKillByMapping,
};
