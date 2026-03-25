const { calculateGameCountdown: calculateCountdown } = require('./timer');
const { SNAKES_LADDERS_CONFIG } = require('../config/snakesladdersConfig');

// ============================================================================
// Ludo Timer Payload
// ============================================================================

const LUDO_GAME_DURATION_SECONDS = 300;

// ============================================================================
// Creates timer update payload for Ludo
// ============================================================================
function createLudoTimerUpdatePayload(matchData, user1TimeSec, user2TimeSec, user1Chance, user2Chance, userScores, gameStatus, gameStats) {
  const extractPieceData = (pieces) => {
    if (!Array.isArray(pieces)) return [];
    return pieces.map(piece => ({
      piece_id: piece.piece_id,
      from_pos: Number(piece.from_pos_last) || 0,
      to_pos: Number(piece.to_pos_last) || 0
    }));
  };

  const startTimeField = matchData.start_time || matchData.created_at;
  const currentTime = Date.now();
  const countdownSeconds = calculateCountdown(startTimeField, currentTime, LUDO_GAME_DURATION_SECONDS);

  if (!startTimeField) {
    matchData.start_time = new Date().toISOString();
  }

  return {
    game_id: matchData.game_id,
    status: gameStatus,

    user1_id: matchData.user1_id,
    user2_id: matchData.user2_id,

    user1_time: (user1TimeSec !== null && user1TimeSec !== undefined) ? user1TimeSec : 15,
    user2_time: (user2TimeSec !== null && user2TimeSec !== undefined) ? user2TimeSec : 15,
    turn: matchData.turn || '',
    
    user1_connection_count: matchData.user1_connection_count || 0,
    user2_connection_count: matchData.user2_connection_count || 0,
    user1_chance: (user1Chance !== null && user1Chance !== undefined && !isNaN(user1Chance)) ? user1Chance : 0,
    user2_chance: (user2Chance !== null && user2Chance !== undefined && !isNaN(user2Chance)) ? user2Chance : 0,
    
    user1_score: (userScores.user1_score !== null && userScores.user1_score !== undefined) ? userScores.user1_score : 0,
    user2_score: (userScores.user2_score !== null && userScores.user2_score !== undefined) ? userScores.user2_score : 0,

    winner: matchData.winner || null,
    game_end_reason: matchData.game_end_reason || null,

    game_stats: gameStats,

    user1_turn_count: matchData.turnCount ? matchData.turnCount[matchData.user1_id] || 0 : 0,
    user2_turn_count: matchData.turnCount ? matchData.turnCount[matchData.user2_id] || 0 : 0,

    user1_pieces: extractPieceData(matchData.user1_pieces),
    user2_pieces: extractPieceData(matchData.user2_pieces),

    match_start_time: startTimeField,
    elapsed_time_seconds: countdownSeconds,
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Snakes & Ladders Timer Payload
// ============================================================================

const SNAKES_GAME_DURATION_SECONDS = SNAKES_LADDERS_CONFIG.TIMER.GAME_DURATION_SECONDS;

// ============================================================================
// Creates timer update payload for Snakes & Ladders
// ============================================================================
function createSnakesTimerUpdatePayload(matchData, user1TimeSec, user2TimeSec, user1Chance, user2Chance, userScores, gameStatus, gameStats) {
  const extractPieceData = (pieces) => {
    if (!Array.isArray(pieces)) {
      return [];
    }
    return pieces.map(piece => ({
      piece_id: piece.piece_id || null,
      position: Number(piece.position) || 0,
      from_pos: Number(piece.from_pos_last) || 0,
      to_pos: Number(piece.to_pos_last) || 0,
      is_home: piece.is_home || false,
      is_finished: piece.is_finished || false
    }));
  };

  const startTimeField = matchData.start_time || matchData.created_at;
  const currentTime = Date.now();
  const countdownSeconds = calculateCountdown(startTimeField, currentTime, SNAKES_GAME_DURATION_SECONDS);

  if (!startTimeField) {
    matchData.start_time = new Date().toISOString();
  }

  const MAX_TIMER_SECONDS = SNAKES_LADDERS_CONFIG.TIMER.MAX_TIMER_SECONDS;

  return {
    game_id: matchData.game_id,
    game_type: 'snakes_ladders',
    status: gameStatus,

    user1_id: matchData.user1_id,
    user2_id: matchData.user2_id,

    user1_time: (user1TimeSec !== null && user1TimeSec !== undefined) ? user1TimeSec : MAX_TIMER_SECONDS,
    user2_time: (user2TimeSec !== null && user2TimeSec !== undefined) ? user2TimeSec : MAX_TIMER_SECONDS,
    turn: matchData.turn || '',

    user1_connection_count: matchData.user1_connection_count || 0,
    user2_connection_count: matchData.user2_connection_count || 0,
    user1_chance: (user1Chance !== null && user1Chance !== undefined && !isNaN(user1Chance)) ? user1Chance : 0,
    user2_chance: (user2Chance !== null && user2Chance !== undefined && !isNaN(user2Chance)) ? user2Chance : 0,

    user1_score: (userScores.user1_score !== null && userScores.user1_score !== undefined) ? userScores.user1_score : 0,
    user2_score: (userScores.user2_score !== null && userScores.user2_score !== undefined) ? userScores.user2_score : 0,

    winner: matchData.winner || null,
    game_end_reason: matchData.game_end_reason || null,

    game_stats: gameStats,

    user1_turn_count: matchData.turnCount ? matchData.turnCount[matchData.user1_id] || 0 : 0,
    user2_turn_count: matchData.turnCount ? matchData.turnCount[matchData.user2_id] || 0 : 0,

    user1_pieces: extractPieceData(matchData.user1_pieces || []),
    user2_pieces: extractPieceData(matchData.user2_pieces || []),

    last_dice_roll: matchData.last_dice_roll || null,
    last_dice_user: matchData.last_dice_user || null,
    last_dice_time: matchData.last_dice_time || null,

    match_start_time: startTimeField,
    elapsed_time_seconds: countdownSeconds,
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Tic-Tac-Toe Timer Payload
// ============================================================================

const TICTACTOE_TIMER_CONFIG = {
  MAX_TIMER_SECONDS: 60,
  GAME_DURATION_SECONDS: 300,
};

// ============================================================================
// Creates timer update payload for Tic-Tac-Toe
// ============================================================================
function createTicTacToeTimerUpdatePayload(matchData, user1TimeSec, user2TimeSec, user1Chance, user2Chance, gameStats, gameStatus) {
  const startTimeField = matchData.start_time || matchData.created_at;
  const currentTime = Date.now();
  const countdownSeconds = calculateCountdown(startTimeField, currentTime, TICTACTOE_TIMER_CONFIG.GAME_DURATION_SECONDS);

  return {
    game_id: matchData.game_id,
    game_type: "tictactoe",
    status: gameStatus,

    user1_id: matchData.user1_id,
    user2_id: matchData.user2_id,

    user1_time: (user1TimeSec !== null && user1TimeSec !== undefined) ? user1TimeSec : TICTACTOE_TIMER_CONFIG.MAX_TIMER_SECONDS,
    user2_time: (user2TimeSec !== null && user2TimeSec !== undefined) ? user2TimeSec : TICTACTOE_TIMER_CONFIG.MAX_TIMER_SECONDS,
    turn: matchData.turn || '',

    user1_connection_count: matchData.user1_connection_count || 0,
    user2_connection_count: matchData.user2_connection_count || 0,
    user1_chance: (user1Chance !== null && user1Chance !== undefined && !isNaN(user1Chance)) ? user1Chance : 0,
    user2_chance: (user2Chance !== null && user2Chance !== undefined && !isNaN(user2Chance)) ? user2Chance : 0,

    board: Array.isArray(matchData.board)
      ? matchData.board.map((c) => (c == null ? 0 : c))
      : Array(9).fill(0),
    move_history: Array.isArray(matchData.moveHistory)
      ? matchData.moveHistory
      : [],
    winner: matchData.winner || null,
    game_end_reason: matchData.game_end_reason || null,
    cleared_position: matchData.cleared_position !== undefined ? matchData.cleared_position : null,

    game_stats: gameStats,

    match_start_time: startTimeField,
    elapsed_time_seconds: countdownSeconds,
    user1_time_iso: matchData.user1_time || null,
    user2_time_iso: matchData.user2_time || null,

    created_at: matchData.created_at || null,
    updated_at: matchData.updated_at || null,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Water Sort Timer Payload
// ============================================================================

const WATERSORT_TIMER_CONFIG = {
  MAX_TIMER_SECONDS: 300,
  GAME_DURATION_SECONDS: 300,
};

// ============================================================================
// Calculates remaining time for a user
// ============================================================================
function calculateRemainingTime(userStartTime, currentTime) {
  if (!userStartTime) return WATERSORT_TIMER_CONFIG.MAX_TIMER_SECONDS;
  const start = new Date(userStartTime).getTime();
  if (isNaN(start)) return WATERSORT_TIMER_CONFIG.MAX_TIMER_SECONDS;
  const elapsed = Math.floor((currentTime - start) / 1000);
  return Math.max(0, WATERSORT_TIMER_CONFIG.MAX_TIMER_SECONDS - elapsed);
}

// ============================================================================
// Gets game statistics from match data
// ============================================================================
function getGameStats(match) {
  try {
    const moveHistoryMoves = Array.isArray(match.moveHistory) ? match.moveHistory.length : 0;
    const sequenceMoves = Array.isArray(match.move_sequence) ? match.move_sequence.length : 0;
    const countMoves = match.move_count || 0;
    
    const moves = moveHistoryMoves > 0 ? moveHistoryMoves : (sequenceMoves > 0 ? sequenceMoves : countMoves);
    
    const stats = {
      total_moves: moves,
      level_no: match.level_no || 0,
      moves_per_minute: 0,
      user1_moves: 0,
      user2_moves: 0,
    };
    
    if (Array.isArray(match.moveHistory)) {
      match.moveHistory.forEach(move => {
        if (move.user_id === match.user1_id) {
          stats.user1_moves++;
        } else if (move.user_id === match.user2_id) {
          stats.user2_moves++;
        }
      });
    }
    
    if (match.start_time && match.updated_at) {
      const start = new Date(match.start_time);
      const updated = new Date(match.updated_at);
      const durationSec = Math.max(1, Math.floor((updated - start) / 1000));
      stats.moves_per_minute = Math.round((moves / durationSec) * 60);
    }
    return stats;
  } catch (_) {
    return { total_moves: 0, level_no: 0, moves_per_minute: 0, user1_moves: 0, user2_moves: 0 };
  }
}

// ============================================================================
// Creates timer update payload for Water Sort
// ============================================================================
function createWatersortTimerUpdatePayload(matchData, user1TimeSec, user2TimeSec, user1Chance, user2Chance, gameStats, gameStatus) {
  const startTimeField = matchData.start_time || matchData.created_at;
  const currentTime = Date.now();
  const countdownSeconds = calculateCountdown(startTimeField, currentTime, WATERSORT_TIMER_CONFIG.GAME_DURATION_SECONDS);

  const user1Time = (typeof user1TimeSec === 'number' && user1TimeSec !== null && user1TimeSec !== undefined) 
    ? user1TimeSec 
    : WATERSORT_TIMER_CONFIG.MAX_TIMER_SECONDS;
  const user2Time = (typeof user2TimeSec === 'number' && user2TimeSec !== null && user2TimeSec !== undefined) 
    ? user2TimeSec 
    : WATERSORT_TIMER_CONFIG.MAX_TIMER_SECONDS;

  return {
    game_id: matchData.game_id,
    game_type: 'watersort',
    status: gameStatus,
    user1_id: matchData.user1_id,
    user2_id: matchData.user2_id,
    user1_time: user1Time,
    user2_time: user2Time,
    user1_score: matchData.user1_score || 0,
    user2_score: matchData.user2_score || 0,
    user1_current_stage: matchData.user1_current_stage || 1,
    user2_current_stage: matchData.user2_current_stage || 1,
    user1_stages_completed: matchData.user1_stages_completed || 0,
    user2_stages_completed: matchData.user2_stages_completed || 0,
    user1_connection_count: matchData.user1_connection_count || 0,
    user2_connection_count: matchData.user2_connection_count || 0,
    user1_chance: (typeof user1Chance === 'number' && !isNaN(user1Chance)) ? user1Chance : 0,
    user2_chance: (typeof user2Chance === 'number' && !isNaN(user2Chance)) ? user2Chance : 0,
    level_no: matchData.level_no || 0,
    move_count: matchData.move_count || 0,
    move_sequence: Array.isArray(matchData.move_sequence) ? matchData.move_sequence : [],
    move_history: Array.isArray(matchData.moveHistory) ? matchData.moveHistory : [],
    puzzle_state: matchData.puzzle_state || null,
    winner: matchData.winner || null,
    game_end_reason: matchData.game_end_reason || null,
    game_stats: gameStats,
    match_start_time: startTimeField,
    elapsed_time_seconds: countdownSeconds,
    user1_time_iso: matchData.user1_time,
    user2_time_iso: matchData.user2_time,
    user1_start_time_iso: matchData.user1_start_time,
    user2_start_time_iso: matchData.user2_start_time,
    created_at: matchData.created_at,
    updated_at: matchData.updated_at,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  createLudoTimerUpdatePayload,
  createSnakesTimerUpdatePayload,
  createTicTacToeTimerUpdatePayload,
  createWatersortTimerUpdatePayload,
  calculateRemainingTime,
  getGameStats
};
