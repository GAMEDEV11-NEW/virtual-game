CREATE TABLE ludo_game (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- row identity
  l_id VARCHAR(64) NOT NULL,                  -- current user's join id
  opponent_l_id VARCHAR(64) NULL,             -- opponent row link
  user_id BIGINT UNSIGNED NOT NULL,
  opponent_user_id BIGINT UNSIGNED NULL,

  -- contest/match routing
  contest_id BIGINT UNSIGNED NOT NULL,
  league_id BIGINT UNSIGNED NOT NULL,
  opponent_league_id BIGINT UNSIGNED NULL,
  match_id VARCHAR(64) NULL,

  -- matchmaking/runtime control
  status VARCHAR(24) NOT NULL DEFAULT 'pending',   -- pending/matched/active/completed/expired
  status_id TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- 1/2/3/4/5
  turn_id BIGINT UNSIGNED NULL,
  winner_user_id BIGINT UNSIGNED NULL,
  join_day DATE NOT NULL,
  server_id VARCHAR(32) NOT NULL DEFAULT '0',

  -- generated ids
  user_dice_id VARCHAR(64) NULL,
  opponent_dice_id VARCHAR(64) NULL,
  user_piece_1_id VARCHAR(64) NULL,
  user_piece_2_id VARCHAR(64) NULL,
  user_piece_3_id VARCHAR(64) NULL,
  user_piece_4_id VARCHAR(64) NULL,
  opponent_piece_1_id VARCHAR(64) NULL,
  opponent_piece_2_id VARCHAR(64) NULL,
  opponent_piece_3_id VARCHAR(64) NULL,
  opponent_piece_4_id VARCHAR(64) NULL,

  -- game state pointer
  s3_key VARCHAR(512) NULL,
  s3_etag VARCHAR(128) NULL,
  move_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_move_at DATETIME(3) NULL,

  -- safety + lifecycle
  lock_version INT UNSIGNED NOT NULL DEFAULT 1,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,

  -- timestamps
  joined_at DATETIME(3) NOT NULL,
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uk_lid (l_id),
  UNIQUE KEY uk_match_user (match_id, user_id),

  KEY idx_pending_scan (status_id, join_day, league_id, server_id, joined_at),
  KEY idx_user_lookup (user_id, contest_id, status_id),
  KEY idx_match_lookup (match_id),
  KEY idx_opponent_lid (opponent_l_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;




