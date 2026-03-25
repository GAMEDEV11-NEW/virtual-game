// ============================================================================
// Game Status Constants
// ============================================================================
const GAME_STATUS = {
  PENDING: '1',
  MATCHED: 'matched',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

// ============================================================================
// Redis TTL Constants
// ============================================================================
const REDIS_TTL = {
  MATCH_SECONDS: 24 * 60 * 60, // 24 hours
  SESSION_SECONDS: 60 * 60, // 1 hour
  CACHE_SECONDS: 5 * 60 // 5 minutes
};

// ============================================================================
// Game Type Constants
// ============================================================================
const GAME_TYPES = {
  LUDO: 'ludo',
  SNAKES_LADDERS: 'snakesladders',
  TIC_TAC_TOE: 'tictactoe',
  WATER_SORT: 'watersort'
};

// ============================================================================
// Contest Type Constants
// ============================================================================
const CONTEST_TYPES = {
  SIMPLE: 'simple',
  QUICK: 'quick',
  CLASSIC: 'classic'
};

// ============================================================================
// Game End Reason Constants
// ============================================================================
const GAME_END_REASONS = {
  OPPONENT_QUIT: 'opponent_quit',
  TIMEOUT: 'timeout',
  WIN: 'win',
  TIE: 'tie'
};

// ============================================================================
// Chance/Attempt Constants
// ============================================================================
const CHANCE_CONSTANTS = {
  DEFAULT_MAX_CHANCES: 3,
  TIC_TAC_TOE_CHANCES: 1,
  WATER_SORT_CHANCES: 1
};

// ============================================================================
// Timer Constants
// ============================================================================
const TIMER_CONSTANTS = {
  MATCHMAKING_TICK: 2000, // 2 seconds
  USER_TIMER_TICK: 1000, // 1 second
  TURN_TIMEOUT_SECONDS: 30 // 30 seconds
};

// ============================================================================
// Socket Event Constants
// ============================================================================
const SOCKET_EVENTS = {
  CONNECTION_ESTABLISHED: 'connection:established',
  DISCONNECT: 'disconnect',
  STOP_TIMER_UPDATES: 'stop:timer_updates'
};

// ============================================================================
// Redis Key Prefix Constants
// ============================================================================
const REDIS_KEYS = {
  MATCH: (gameId) => `match:${gameId}`,
  SNAKES_MATCH: (gameId) => `snakesladders_match:${gameId}`,
  TICTACTOE_MATCH: (gameId) => `tictactoe_match:${gameId}`,
  WATERSORT_MATCH: (gameId) => `watersort_match:${gameId}`,
  USER_CHANCE: (gameId) => `matchkey_userchance:${gameId}`,
  SNAKES_USER_CHANCE: (gameId) => `snakesladders_userchance:${gameId}`,
  TICTACTOE_USER_CHANCE: (gameId) => `tictactoe_userchance:${gameId}`,
  WATERSORT_USER_CHANCE: (gameId) => `watersort_userchance:${gameId}`,
  SOCKET_TO_USER: (socketId) => `socket_to_user:${socketId}`,
  USER_TO_SOCKET: (userId) => `user_to_socket:${userId}`,
  WATERSORT_LEVELS_CACHE: 'watersort:levels:cache',
  WATERSORT_LEVEL_CACHE: (levelNo) => `watersort:level:${levelNo}`
};

// ============================================================================
// Database Query Constants
// ============================================================================
const DB_QUERIES = {
  SELECT_PENDING: `
    SELECT user_id, league_id, joined_at, id, status_id, join_day, extra_data, game_type, contest_type, server_id, b_s
    FROM pending_league_joins
    WHERE status_id = ? AND join_day = ? AND league_id IN ? AND server_id = ?
    LIMIT 10000
  `,
  INSERT_MATCH_PAIR: `
    INSERT INTO match_pairs (id, user1_id, user2_id, user1_data, user2_data, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  INSERT_DICE_LOOKUP: `
    INSERT INTO dice_rolls_lookup (game_id, user_id, dice_id, created_at)
    VALUES (?, ?, ?, ?)
  `,
  UPDATE_PENDING_OPPONENT: `
    UPDATE pending_league_joins SET opponent_user_id = ?
    WHERE status_id = ? AND join_day = ? AND league_id = ? AND server_id = ? AND joined_at = ?
  `,
  DELETE_PENDING: `
    DELETE FROM pending_league_joins WHERE status_id = ? AND join_day = ? AND league_id = ? AND server_id = ? AND joined_at = ?
  `,
  DELETE_PENDING_BY_STATUS: `
    DELETE FROM pending_league_joins_by_status WHERE user_id = ? AND status_id = ? AND joined_at = ?
  `,
  UPDATE_LEAGUE_JOIN: `
    UPDATE league_joins
    SET opponent_user_id = ?, opponent_league_id = ?, match_pair_id = ?, turn_id = ?, status = ?
    WHERE user_id = ? AND status_id = ? AND join_month = ? AND joined_at = ?
  `,
  UPDATE_LEAGUE_EXPIRED: `
    UPDATE league_joins SET status = ?, opponent_user_id = null, opponent_league_id = null WHERE user_id = ? AND status_id = ? AND join_month = ? AND joined_at = ?
  `,
  SELECT_LEAGUE_JOIN_EXTRA: `
    SELECT extra_data, entry_fee, id FROM league_joins WHERE user_id = ? AND status_id = ? AND join_month = ?
  `,
  SELECT_LEAGUE_JOIN_BY_ID: `
    SELECT id, entry_fee, extra_data, invite_code, join_month, joined_at, league_id, match_pair_id, opponent_league_id, opponent_user_id, r_ip, role, status, status_id, turn_id, updated_at, user_id FROM league_joins_by_id WHERE id = ?
  `,
  INSERT_LEAGUE_JOIN_BY_ID: `
    INSERT INTO league_joins_by_id (id, entry_fee, extra_data, invite_code, join_month, joined_at, league_id, match_pair_id, opponent_league_id, opponent_user_id, r_ip, role, status, status_id, turn_id, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  UPDATE_LEAGUE_JOIN_BY_ID: `
    UPDATE league_joins_by_id SET opponent_user_id = ?, opponent_league_id = ?, match_pair_id = ?, turn_id = ?, status = ?, status_id = ?, updated_at = ? WHERE id = ?
  `,
  UPDATE_LEAGUE_JOIN_BY_ID_EXPIRED: `
    UPDATE league_joins_by_id SET status = ?, status_id = ?, opponent_user_id = null, opponent_league_id = null, match_pair_id = null, updated_at = ? WHERE id = ?
  `,
  UPDATE_LEAGUE_JOIN_BY_ID_STATUS_ONLY: `
    UPDATE league_joins_by_id SET status = ?, status_id = ?, updated_at = ? WHERE id = ?
  `,
  SELECT_USER_DETAILS: `
    SELECT full_name, profile_data FROM users WHERE id = ?
  `,
  SELECT_LEVEL_MAP: `
    SELECT map_data FROM levels WHERE level_no = ?
  `,
  SELECT_ALL_LEVELS: `
    SELECT level_no, map_data FROM levels
  `,
  INSERT_GAME_MOVE: `
    INSERT INTO game_moves (
      game_id, user_id, game_type, move_type, move_number, move_data,
      position_x, position_y, position_index, target_position_x, target_position_y, target_position_index,
      value, score, move_time, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
};

// ============================================================================
// Utility Functions
// ============================================================================
function getContestTypeMaxChances(contestType) {
  switch (contestType) {
    case CONTEST_TYPES.SIMPLE:
    case CONTEST_TYPES.QUICK:
    case CONTEST_TYPES.CLASSIC:
      return CHANCE_CONSTANTS.DEFAULT_MAX_CHANCES;
    default:
      return CHANCE_CONSTANTS.DEFAULT_MAX_CHANCES;
  }
}

function getTodayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getCurrentMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

module.exports = {
  GAME_STATUS,
  REDIS_TTL,
  GAME_TYPES,
  CONTEST_TYPES,
  GAME_END_REASONS,
  CHANCE_CONSTANTS,
  TIMER_CONSTANTS,
  SOCKET_EVENTS,
  REDIS_KEYS,
  DB_QUERIES,
  getContestTypeMaxChances,
  getTodayString,
  getCurrentMonth
};

