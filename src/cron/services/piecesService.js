// ============================================================================
// Game Pieces Service
// ============================================================================

const { v4: uuidv4 } = require('uuid');

const INSERT_PIECE = `INSERT INTO game_pieces (
  game_id, user_id, move_number, piece_id, player_id,
  from_pos_last, to_pos_last, piece_type, captured_piece,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_PIECES = `SELECT game_id, user_id, move_number, piece_id, player_id,
  from_pos_last, to_pos_last, piece_type, captured_piece,
  created_at, updated_at FROM game_pieces
  WHERE game_id = ? AND user_id = ? ORDER BY move_number ASC`;

const SELECT_DICE = `SELECT dice_id, created_at FROM dice_rolls_lookup WHERE game_id = ? AND user_id = ? LIMIT 1`;

class GamePiecesService {
  constructor(session) {
    if (!session) throw new Error('Cassandra session required');
    this.session = session;
  }

  async createPiecesForMatch(gameId, user1Id, user2Id, startingPosition = 0) {
    if (gameId == null || user1Id == null || user2Id == null) {
      return;
    }

    const [existing1, existing2] = await Promise.all([
      this.getUserPieces(gameId, user1Id),
      this.getUserPieces(gameId, user2Id)
    ]);
    if ((existing1?.length || 0) > 0 || (existing2?.length || 0) > 0) {
      return;
    }

    await Promise.all([
      this.#createUserPieces(gameId, user1Id, 'player1', startingPosition),
      this.#createUserPieces(gameId, user2Id, 'player2', startingPosition)
    ]);
  }

  async createSnakesLaddersPiecesForMatch(gameId, user1Id, user2Id) {
    if (gameId == null || user1Id == null || user2Id == null) {
      return;
    }

    const [existing1, existing2] = await Promise.all([
      this.getUserPieces(gameId, user1Id),
      this.getUserPieces(gameId, user2Id)
    ]);
    if ((existing1?.length || 0) > 0 || (existing2?.length || 0) > 0) {
      return;
    }

    await Promise.all([
      this.#createSnakesPieces(gameId, user1Id, 'player1'),
      this.#createSnakesPieces(gameId, user2Id, 'player2')
    ]);
  }

  async getUserPieces(gameId, userId) {
    if (gameId == null || userId == null) {
      return [];
    }
    const result = await this.session.execute(SELECT_PIECES, [gameId, userId], { prepare: true });
    return result.rows.map((row) => ({
      game_id: row.game_id || '',
      user_id: row.user_id || '',
      move_number: row.move_number !== undefined && row.move_number !== null ? String(row.move_number) : '0',
      piece_id: row.piece_id || '',
      player_id: row.player_id || '',
      from_pos_last: row.from_pos_last || '',
      to_pos_last: row.to_pos_last || '',
      piece_type: row.piece_type || '',
      captured_piece: row.captured_piece || '',
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    }));
  }

  async getUserDice(gameId, userId) {
    if (gameId == null || userId == null) {
      return [];
    }
    const result = await this.session.execute(SELECT_DICE, [gameId, userId], { prepare: true });
    if (result.rowLength === 0) {
      return [];
    }
    const row = result.first();
    return [
      {
        dice_id: row.dice_id?.toString?.() || String(row.dice_id || ''),
        created_at: row.created_at || null
      }
    ];
  }

  async #createUserPieces(gameId, userId, playerId, startingPosition) {
    if (gameId == null || userId == null) {
      throw new Error('Missing required parameters for piece creation');
    }
    
    const pieces = startingPosition === 1 ? 2 : 4;
    const now = new Date();
    const statements = [];
    for (let i = 1; i <= pieces; i += 1) {
      const pieceId = uuidv4();
      const pieceType = `piece_${i}`;
      const fromPos = startingPosition === 1 ? '0' : 'initial';
      const toPos = startingPosition === 1 ? '1' : 'initial';
      statements.push({
        query: INSERT_PIECE,
        params: [
          gameId,
          userId,
          0,
          pieceId,
          playerId,
          fromPos,
          toPos,
          pieceType,
          '',
          now,
          now
        ]
      });
    }
    await this.session.batch(statements, { prepare: true });
  }

  async #createSnakesPieces(gameId, userId, playerId) {
    const { SNAKES_LADDERS_CONFIG } = require('../../config/snakesladdersConfig');
    const piecesPerPlayer = SNAKES_LADDERS_CONFIG.PIECES_PER_PLAYER || 2;
    
    const now = new Date();
    const statements = [];
    for (let i = 1; i <= piecesPerPlayer; i += 1) {
      statements.push({
        query: INSERT_PIECE,
        params: [
          gameId,
          userId,
          0,
          uuidv4(),
          playerId,
          '0',
          '0',
          `piece_${i}`,
          '',
          now,
          now
        ]
      });
    }
    await this.session.batch(statements, { prepare: true });
  }
}

module.exports = { GamePiecesService };

