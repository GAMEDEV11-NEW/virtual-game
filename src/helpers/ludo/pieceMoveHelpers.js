const cassandraClient = require('../../services/cassandra/client');
const { redis: redisClient } = require('../../utils/redis');
const { findActiveOpponentSocketId } = require('../common/gameHelpers');
const { REDIS_KEYS } = require('../../constants');

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
    if (userID === match.user1_id) userPiecesKey = 'user1_pieces';
    else if (userID === match.user2_id) userPiecesKey = 'user2_pieces';
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
    if (userID === match.user1_id && match.user1_pieces) {
      userPieces = match.user1_pieces;
      userPiecesKey = 'user1_pieces';
    } else if (userID === match.user2_id && match.user2_pieces) {
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
          if (userID === updatedMatch.user1_id && updatedMatch.user1_pieces) {
            userPieces = updatedMatch.user1_pieces;
            userPiecesKey = 'user1_pieces';
          } else if (userID === updatedMatch.user2_id && updatedMatch.user2_pieces) {
            userPieces = updatedMatch.user2_pieces;
            userPiecesKey = 'user2_pieces';
          }
        }
      }
    }
    if (userPieces) {
      const movedPiece = userPieces.find(piece => piece.piece_id === pieceID);
      if (movedPiece) {
        movedPiece.from_pos_last = fromPos;
        movedPiece.to_pos_last = toPos;
        movedPiece.piece_type = pieceType;
        movedPiece.updated_at = now;
        if (userPiecesKey === 'user1_pieces') match.user1_pieces = userPieces;
        else if (userPiecesKey === 'user2_pieces') match.user2_pieces = userPieces;
        await redisClient.set(matchKey, JSON.stringify(match));
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  } catch (_) {
    return false;
  }
}

async function processPieceMove({ gameID, userID, pieceID, fromPos, toPos, pieceType, capturedPiece }) {
  const now = new Date().toISOString();
  let existing;
  try {
    const result = await cassandraClient.execute(
      'SELECT move_number, from_pos_last, to_pos_last, piece_type FROM game_pieces WHERE game_id = ? AND user_id = ? AND move_number = 0 AND piece_id = ?',
      [gameID, userID, pieceID],
      { prepare: true }
    );
    existing = result.rowLength > 0 ? result.first() : null;
  } catch (err) {
    throw new Error('Failed to check existing piece: ' + err.message);
  }
  if (!existing) {
    try {
      await cassandraClient.execute(
        'INSERT INTO game_pieces (game_id, user_id, move_number, piece_id, player_id, from_pos_last, to_pos_last, piece_type, captured_piece, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [gameID, userID, 0, pieceID, userID, '', 'initial', pieceType, '', now, now],
        { prepare: true }
      );
    } catch (err) {
      throw new Error('Failed to insert initial piece: ' + err.message);
    }
  }
  try {
    await cassandraClient.execute(
      'UPDATE game_pieces SET from_pos_last = ?, to_pos_last = ?, piece_type = ?, captured_piece = ?, updated_at = ? WHERE game_id = ? AND user_id = ? AND move_number = 0 AND piece_id = ?',
      [fromPos, toPos, pieceType, capturedPiece, now, gameID, userID, pieceID],
      { prepare: true }
    );
  } catch (err) {
    throw new Error('Failed to update piece move: ' + err.message);
  }
  try {
    await updatePiecePositionInMatch(gameID, userID, pieceID, fromPos, toPos, pieceType);
  } catch (_) { }
  (async () => {
    try {
      await cassandraClient.execute(
        `INSERT INTO myapp.piece_moves (
          game_id, user_id, piece_id, created_at, current_state, last_move_time, last_position,
          move_history, piece_metadata, player_id, total_moves, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gameID, userID, pieceID, new Date(), null, new Date(), toPos, null, null, userID, 1, new Date()],
        { prepare: true }
      );
    } catch (_) { }
  })();
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

