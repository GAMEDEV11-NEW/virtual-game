const { SNAKES_LADDERS_CONFIG } = require('../../config/snakesladdersConfig');
const BOARD_CONFIG = SNAKES_LADDERS_CONFIG.BOARD;
const cassandraClient = require('../../services/cassandra/client');

const GAME_CONFIG = {
  MAX_PLAYERS: SNAKES_LADDERS_CONFIG.MAX_PLAYERS,
  MIN_PLAYERS: SNAKES_LADDERS_CONFIG.MIN_PLAYERS,
  WINNING_POSITION: SNAKES_LADDERS_CONFIG.WINNING_POSITION,
  STARTING_POSITION: SNAKES_LADDERS_CONFIG.STARTING_POSITION,
  MAX_DICE_VALUE: SNAKES_LADDERS_CONFIG.DICE.MAX_VALUE,
  MIN_DICE_VALUE: SNAKES_LADDERS_CONFIG.DICE.MIN_VALUE,
  PIECES_PER_PLAYER: SNAKES_LADDERS_CONFIG.PIECES_PER_PLAYER,
  MIN_PIECES_PER_PLAYER: SNAKES_LADDERS_CONFIG.MIN_PIECES_PER_PLAYER,
  MAX_PIECES_PER_PLAYER: SNAKES_LADDERS_CONFIG.MAX_PIECES_PER_PLAYER
};

// ============================================================================
// Checks if a position has a snake or ladder
// ============================================================================
function checkSnakeOrLadder(position) {
  const pos = parseInt(position);
  
  for (const [start, end] of BOARD_CONFIG.LADDERS) {
    if (pos === start) {
      return {
        hasSnakeOrLadder: true,
        newPosition: end,
        type: 'ladder',
        message: `Ladder! Moved from ${start} to ${end}`,
        startPosition: start,
        endPosition: end
      };
    }
  }

  for (const [start, end] of BOARD_CONFIG.SNAKES) {
    if (pos === start) {
      return {
        hasSnakeOrLadder: true,
        newPosition: end,
        type: 'snake',
        message: `Snake! Moved from ${start} to ${end}`,
        startPosition: start,
        endPosition: end
      };
    }
  }

  return {
    hasSnakeOrLadder: false,
    newPosition: pos,
    type: null,
    message: null,
    startPosition: null,
    endPosition: null
  };
}

// ============================================================================
// Validates if a position is valid on the board
// ============================================================================
function isValidPosition(position) {
  return position >= GAME_CONFIG.STARTING_POSITION && position <= GAME_CONFIG.WINNING_POSITION;
}

// ============================================================================
// Validates if a dice roll is valid
// ============================================================================
function isValidDiceRoll(diceValue) {
  return diceValue >= GAME_CONFIG.MIN_DICE_VALUE && diceValue <= GAME_CONFIG.MAX_DICE_VALUE;
}

// ============================================================================
// Checks if a player has won
// ============================================================================
function hasWon(position) {
  return position === GAME_CONFIG.WINNING_POSITION;
}

// ============================================================================
// Calculates the new position after a dice roll
// ============================================================================
function calculateNewPosition(currentPosition, diceValue) {
  if (!isValidPosition(currentPosition) || !isValidDiceRoll(diceValue)) {
    return {
      isValid: false,
      newPosition: currentPosition,
      error: 'Invalid position or dice value'
    };
  }

  const newPosition = currentPosition + diceValue;
  
  if (newPosition > GAME_CONFIG.WINNING_POSITION) {
    return {
      isValid: false,
      newPosition: currentPosition,
      error: 'Move would exceed winning position',
      canMove: false
    };
  }

  const snakeOrLadder = checkSnakeOrLadder(newPosition);
  
  return {
    isValid: true,
    newPosition: snakeOrLadder.newPosition,
    canMove: true,
    snakeOrLadder: snakeOrLadder,
    hasWon: hasWon(snakeOrLadder.newPosition)
  };
}

// ============================================================================
// Gets the board position coordinates for display
// ============================================================================
function getBoardCoordinates(position) {
  if (position < 1 || position > 100) {
    return { row: -1, col: -1 };
  }

  const row = Math.ceil(position / 10);
  const col = position % 10 === 0 ? 10 : position % 10;
  
  return { row, col };
}

// ============================================================================
// Gets the position number from board coordinates
// ============================================================================
function getPositionFromCoordinates(row, col) {
  if (row < 1 || row > 10 || col < 1 || col > 10) {
    return -1;
  }

  return (row - 1) * 10 + col;
}

// ============================================================================
// Gets all snakes and ladders on the board
// ============================================================================
function getAllSnakesAndLadders() {
  return {
    ladders: BOARD_CONFIG.LADDERS.map(([start, end]) => ({
      start,
      end,
      type: 'ladder',
      message: `Ladder from ${start} to ${end}`
    })),
    snakes: BOARD_CONFIG.SNAKES.map(([start, end]) => ({
      start,
      end,
      type: 'snake',
      message: `Snake from ${start} to ${end}`
    }))
  };
}

// ============================================================================
// Gets game statistics
// ============================================================================
function getGameStatistics(match) {
  const stats = {
    user1_position: match.user1_position || 0,
    user2_position: match.user2_position || 0,
    user1_score: match.user1_score || 0,
    user2_score: match.user2_score || 0,
    total_turns: 0,
    game_duration: 0,
    winner: match.winner || null,
    status: match.status || 'unknown'
  };

  if (match.turnCount) {
    stats.total_turns = Object.values(match.turnCount).reduce((sum, count) => sum + count, 0);
  }

  if (match.created_at && match.updated_at) {
    const created = new Date(match.created_at);
    const updated = new Date(match.updated_at);
    stats.game_duration = Math.floor((updated - created) / 1000);
  }

  return stats;
}

// ============================================================================
// Validates piece count
// ============================================================================
function validatePieceCount(pieceCount) {
  if (!Number.isInteger(pieceCount) || pieceCount < GAME_CONFIG.MIN_PIECES_PER_PLAYER || pieceCount > GAME_CONFIG.MAX_PIECES_PER_PLAYER) {
    return {
      isValid: false,
      error: `Piece count must be between ${GAME_CONFIG.MIN_PIECES_PER_PLAYER} and ${GAME_CONFIG.MAX_PIECES_PER_PLAYER}`
    };
  }
  return { isValid: true };
}

// ============================================================================
// Creates initial pieces for a player
// ============================================================================
function createPlayerPieces(userId, pieceCount = GAME_CONFIG.PIECES_PER_PLAYER) {
  const validation = validatePieceCount(pieceCount);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  const pieces = [];
  for (let i = 1; i <= pieceCount; i++) {
    pieces.push({
      piece_id: `${userId}_piece_${i}`,
      position: 0,
      from_pos_last: 0,
      to_pos_last: 0,
      is_home: true,
      is_finished: false,
      created_at: new Date().toISOString()
    });
  }
  return pieces;
}

// ============================================================================
// Gets user's pieces from match data
// ============================================================================
function getUserPieces(match, userId) {
  if (match.user1_id === userId) {
    return match.user1_pieces || [];
  } else if (match.user2_id === userId) {
    return match.user2_pieces || [];
  }
  return [];
}

// ============================================================================
// Updates user's pieces in match data
// ============================================================================
function updateUserPieces(match, userId, pieces) {
  if (match.user1_id === userId) {
    match.user1_pieces = pieces;
  } else if (match.user2_id === userId) {
    match.user2_pieces = pieces;
  }
}

// ============================================================================
// Gets a specific piece by ID
// ============================================================================
function getPieceById(match, userId, pieceId) {
  const pieces = getUserPieces(match, userId);
  return pieces.find(piece => piece.piece_id === pieceId) || null;
}

// ============================================================================
// Updates a specific piece
// ============================================================================
function updatePieceById(match, userId, pieceId, updates) {
  const pieces = getUserPieces(match, userId);
  const pieceIndex = pieces.findIndex(piece => piece.piece_id === pieceId);
  
  if (pieceIndex === -1) {
    return false;
  }
  
  pieces[pieceIndex] = { ...pieces[pieceIndex], ...updates };
  updateUserPieces(match, userId, pieces);
  return true;
}

// ============================================================================
// Checks if user has any pieces that can move
// ============================================================================
function getMovablePieces(pieces, diceValue) {
  const movablePieces = [];
  
  if (!pieces || pieces.length === 0) {
    return movablePieces;
  }
  
  pieces.forEach(piece => {
    const currentPosition = parseInt(piece.to_pos_last) || 0;
    
    if (currentPosition === GAME_CONFIG.WINNING_POSITION) {
      return;
    }
    
    const newPosition = currentPosition + diceValue;
    
    if (newPosition <= GAME_CONFIG.WINNING_POSITION) {
      movablePieces.push({
        ...piece,
        canMove: true,
        newPosition: newPosition,
        currentPosition: currentPosition,
        distanceTo100: GAME_CONFIG.WINNING_POSITION - currentPosition,
        requiredNumberToReach100: GAME_CONFIG.WINNING_POSITION - currentPosition <= 6 ? GAME_CONFIG.WINNING_POSITION - currentPosition : null
      });
    }
  });
  
  return movablePieces;
}

// ============================================================================
// Gets the actual piece count for a user from Redis match data
// ============================================================================
function getUserPieceCount(match, userId) {
  const pieces = getUserPieces(match, userId);
  return pieces ? pieces.length : 0;
}

// ============================================================================
// Fetches win amount from contests table and stores it in match data
// ============================================================================
async function fetchAndStoreWinAmount(match, leagueId) {
  try {
    if (!leagueId) {
      return match;
    }

    const query = 'SELECT contest_win_price, contest_name, contest_entryfee FROM myapp.contests WHERE contest_id = ?';
    const result = await cassandraClient.execute(query, [leagueId], { prepare: true });
    
    if (result.rows.length === 0) {
      return match;
    }

    const contest = result.rows[0];
    const winAmount = parseFloat(contest.contest_win_price) || 0;
    
    match.win_amount = winAmount;
    match.contest_data = {
      contest_id: leagueId,
      contest_name: contest.contest_name,
      contest_entryfee: contest.contest_entryfee,
      contest_win_price: contest.contest_win_price
    };
    
    return match;
  } catch (error) {
    return match;
  }
}

// ============================================================================
// Checks if user has won (all pieces at position 100)
// ============================================================================
function hasUserWon(match, userId) {
  const pieces = getUserPieces(match, userId);
  
  if (!pieces || pieces.length === 0) {
    return false;
  }
  
  const hasWon = pieces.every(piece => parseInt(piece.to_pos_last) === GAME_CONFIG.WINNING_POSITION);
  
  return hasWon;
}

// ============================================================================
// Gets win progress for a player
// ============================================================================
function getWinProgress(match, userId) {
  const pieces = getUserPieces(match, userId);
  
  if (!pieces || pieces.length === 0) {
    return {
      totalPieces: 0,
      piecesAtHome: 0,
      piecesRemaining: 0,
      progressPercentage: 0,
      hasWon: false
    };
  }
  
  const totalPieces = pieces.length;
  const piecesAtHome = pieces.filter(piece => parseInt(piece.to_pos_last) === GAME_CONFIG.WINNING_POSITION).length;
  const piecesRemaining = totalPieces - piecesAtHome;
  
  return {
    totalPieces,
    piecesAtHome,
    piecesRemaining,
    progressPercentage: totalPieces > 0 ? Math.round((piecesAtHome / totalPieces) * 100) : 0,
    hasWon: piecesAtHome === totalPieces
  };
}

// ============================================================================
// Validates game state
// ============================================================================
function validateGameState(match) {
  const errors = [];

  if (!match.game_id) errors.push('Missing game_id');
  if (!match.user1_id) errors.push('Missing user1_id');
  if (!match.user1_pieces || !Array.isArray(match.user1_pieces)) errors.push('Missing user1_pieces');
  if (!match.user2_pieces || !Array.isArray(match.user2_pieces)) errors.push('Missing user2_pieces');
  if (!match.turn) errors.push('Missing turn');
  if (!match.status) errors.push('Missing status');

  if (match.user1_pieces && Array.isArray(match.user1_pieces)) {
    match.user1_pieces.forEach((piece, index) => {
      if (piece.position < 0 || piece.position > 100) {
        errors.push(`Invalid user1_pieces[${index}].position`);
      }
    });
  }
  if (match.user2_pieces && Array.isArray(match.user2_pieces)) {
    match.user2_pieces.forEach((piece, index) => {
      if (piece.position < 0 || piece.position > 100) {
        errors.push(`Invalid user2_pieces[${index}].position`);
      }
    });
  }

  if (match.turn !== match.user1_id && match.turn !== match.user2_id) {
    errors.push('Invalid turn - must be one of the players');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  BOARD_CONFIG,
  GAME_CONFIG,
  checkSnakeOrLadder,
  isValidPosition,
  getWinProgress,
  getUserPieceCount,
  fetchAndStoreWinAmount,
  getUserPieces,
  getPieceById,
  updatePieceById,
  getMovablePieces,
  hasUserWon
};
