const { redis: redisClient } = require('../../utils/redis');
const { findActiveOpponentSocketId } = require('../common/gameHelpers');
const { REDIS_KEYS } = require('../../constants');

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  if (!na || !nb) return false;
  return na === nb;
}

async function loadPiecesIntoMatchState(gameID, userID) {
  try {
    const { safeParseRedisData } = require('../../utils/gameUtils');
    const matchKey = REDIS_KEYS.MATCH(gameID);
    const matchRaw = await redisClient.get(matchKey);
    if (!matchRaw) return false;
    const match = safeParseRedisData(matchRaw);
    if (!match) return false;
    const { getUserPiecesCurrentState } = require('../../services/ludo/gameService');
    let userPiecesKey = null;
    if (sameId(userID, match.user1_id)) userPiecesKey = 'user1_pieces';
    else if (sameId(userID, match.user2_id)) userPiecesKey = 'user2_pieces';
    if (userPiecesKey && !match[userPiecesKey]) {
      const pieces = await getUserPiecesCurrentState(gameID, userID);
      match[userPiecesKey] = pieces;
      await redisClient.set(matchKey, JSON.stringify(match));
      return true;
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function updatePiecePositionInMatch(gameID, userID, pieceID, fromPos, toPos, pieceType) {
  try {
    const { safeParseRedisData } = require('../../utils/gameUtils');
    const matchKey = REDIS_KEYS.MATCH(gameID);
    const matchRaw = await redisClient.get(matchKey);
    if (!matchRaw) return false;
    const match = safeParseRedisData(matchRaw);
    if (!match) return false;
    const now = new Date().toISOString();
    let userPieces = null;
    let userPiecesKey = null;
    if (sameId(userID, match.user1_id) && match.user1_pieces) {
      userPieces = match.user1_pieces;
      userPiecesKey = 'user1_pieces';
    } else if (sameId(userID, match.user2_id) && match.user2_pieces) {
      userPieces = match.user2_pieces;
      userPiecesKey = 'user2_pieces';
    }
    if (!userPieces) {
      const loadSuccess = await loadPiecesIntoMatchState(gameID, userID);
      if (loadSuccess) {
        const updatedMatchRaw = await redisClient.get(matchKey);
        if (updatedMatchRaw) {
          const updatedMatch = safeParseRedisData(updatedMatchRaw);
          if (!updatedMatch) return false;
          if (sameId(userID, updatedMatch.user1_id) && updatedMatch.user1_pieces) {
            userPieces = updatedMatch.user1_pieces;
            userPiecesKey = 'user1_pieces';
          } else if (sameId(userID, updatedMatch.user2_id) && updatedMatch.user2_pieces) {
            userPieces = updatedMatch.user2_pieces;
            userPiecesKey = 'user2_pieces';
          }
        }
      }
    }
    if (userPieces) {
      const movedPiece = userPieces.find(piece => normalizeId(piece.piece_id || piece.id) === normalizeId(pieceID));
      if (movedPiece) {
        movedPiece.from_pos_last = fromPos;
        movedPiece.to_pos_last = toPos;
        movedPiece.piece_type = pieceType;
        movedPiece.updated_at = now;
        if (userPiecesKey === 'user1_pieces') match.user1_pieces = userPieces;
        else if (userPiecesKey === 'user2_pieces') match.user2_pieces = userPieces;
        await redisClient.set(matchKey, JSON.stringify(match));
        return true;
      }

      // If piece does not exist in redis state, create and store it.
      userPieces.push({
        piece_id: String(pieceID),
        id: String(pieceID),
        piece_no: userPieces.length + 1,
        from_pos_last: fromPos,
        to_pos_last: toPos,
        piece_type: pieceType,
        status: 'active',
        created_at: now,
        updated_at: now
      });
      if (userPiecesKey === 'user1_pieces') match.user1_pieces = userPieces;
      else if (userPiecesKey === 'user2_pieces') match.user2_pieces = userPieces;
      await redisClient.set(matchKey, JSON.stringify(match));
      return true;
    } else {
      return false;
    }
  } catch (_) {
    return false;
  }
}

async function processPieceMove({ gameID, userID, pieceID, fromPos, toPos, pieceType, capturedPiece }) {
  const now = new Date().toISOString();
  const updated = await updatePiecePositionInMatch(gameID, userID, pieceID, fromPos, toPos, pieceType);
  if (!updated) {
    throw new Error('Failed to update piece move in redis state');
  }
  const moveConfirmation = {
    status: 'success',
    message: 'Piece move recorded successfully',
    game_id: gameID,
    user_id: userID,
    piece_id: pieceID,
    from_pos: fromPos,
    to_pos: toPos,
    piece_type: pieceType,
    timestamp: now,
    event: 'piece:move:response',
  };
  if (capturedPiece) moveConfirmation.captured_piece = capturedPiece;
  return moveConfirmation;
}

async function broadcastPieceMoveToOpponent(io, gameID, userID, moveResponse) {
  try {
    const opponentSocketId = await findActiveOpponentSocketId(io, gameID, userID, 'ludo');
    if (!opponentSocketId) return false;
    const socketExists = io.sockets.sockets.has(opponentSocketId);
    if (socketExists) {
      const opponentSocket = io.sockets.sockets.get(opponentSocketId);
      if (opponentSocket) {
        io.to(opponentSocketId).emit('opponent:move:update', moveResponse);
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

module.exports = { processPieceMove, broadcastPieceMoveToOpponent, updatePiecePositionInMatch, loadPiecesIntoMatchState };
