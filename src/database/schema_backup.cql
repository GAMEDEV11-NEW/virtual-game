-- ============================================
-- Database Schema Backup
-- Generated: 2025-12-04T11:20:47.249Z
-- Keyspace: myapp
-- Host: 127.0.0.1:9042
-- Equivalent to: DESCRIBE KEYSPACE myapp
-- ============================================
CREATE KEYSPACE IF NOT EXISTS myapp
WITH replication = {'class': 'org.apache.cassandra.locator.SimpleStrategy', 'replication_factor': '1'}
AND durable_writes = true;

USE myapp;

CREATE TABLE IF NOT EXISTS myapp.adsense_configs (
  id uuid,
  ad_placements text,
  ad_refresh_rate int,
  admob_config map<text, text>,
  app_id text,
  banner_ad_unit_id text,
  created_at timestamp,
  facebook_audience_network map<text, text>,
  interstitial_ad_unit_id text,
  is_active boolean,
  is_test_mode boolean,
  max_ad_requests_per_hour int,
  native_ad_unit_id text,
  platform text,
  publisher_id text,
  rewarded_ad_unit_id text,
  test_device_ids list<text>,
  unity_ads_config map<text, text>,
  updated_at timestamp,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'AdSense configurations table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.apk_versions (
  id uuid,
  build_number int,
  created_at timestamp,
  download_url text,
  force_update boolean,
  is_active boolean,
  min_version text,
  platform text,
  release_date timestamp,
  release_notes text,
  update_message text,
  updated_at timestamp,
  version text,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'APK versions table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.banners (
  id int,
  banner_color text,
  banner_description text,
  banner_icon text,
  banner_image text,
  banner_subtitle text,
  banner_title text,
  banner_type text,
  categories text,
  created_at timestamp,
  display_order int,
  end_date timestamp,
  extra_data text,
  is_active boolean,
  key text,
  reward_amount decimal,
  reward_amount_in_word text,
  reward_amount_offer decimal,
  start_date timestamp,
  target_url text,
  updated_at timestamp,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Banners table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.bot_user_ids (
  user_id text,
  base_url text,
  bot_name text,
  redis_db int,
  redis_host text,
  redis_password text,
  redis_port int,
  socket_url text,
  team_name text,
  team_size int,
  user_ip text,
  webhook_url text,
  PRIMARY KEY (user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Bot user IDs table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.contests (
  contest_id text,
  contest_activeuser int,
  contest_endtime text,
  contest_entryfee text,
  contest_joinuser int,
  contest_name text,
  contest_starttime text,
  contest_type text,
  contest_win_price text,
  game_type text,
  metadata text,
  PRIMARY KEY (contest_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Contests table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.daily_free_bets (
  user_id uuid,
  created_at timestamp,
  last_free_bet_date text,
  total_free_bets_used int,
  updated_at timestamp,
  PRIMARY KEY (user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Daily free bets table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.dice_rolls_data (
  lookup_dice_id uuid,
  roll_id uuid,
  contest_id text,
  created_at timestamp,
  device_id text,
  dice_number int,
  roll_timestamp timestamp,
  session_token text,
  PRIMARY KEY (lookup_dice_id, roll_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Dice rolls data table with composite key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.dice_rolls_lookup (
  game_id text,
  user_id text,
  dice_id uuid,
  created_at timestamp,
  PRIMARY KEY ((game_id, user_id), dice_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Dice rolls lookup table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.game_moves (
  game_id text,
  game_type text,
  move_data text,
  move_number int,
  move_time timestamp,
  move_type text,
  position_index int,
  position_x int,
  position_y int,
  score int,
  target_position_index int,
  target_position_x int,
  target_position_y int,
  updated_at timestamp,
  user_id text,
  value text,
  PRIMARY KEY (game_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Game moves table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.game_pieces (
  game_id text,
  user_id text,
  move_number int,
  piece_id uuid,
  captured_piece text,
  created_at timestamp,
  from_pos_last text,
  piece_type text,
  player_id text,
  to_pos_last text,
  updated_at timestamp,
  PRIMARY KEY ((game_id, user_id), move_number, piece_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Game pieces table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.games (
  id text,
  active_gameplay int,
  banner text,
  category text,
  created_at text,
  description text,
  difficulty text,
  game_id text,
  game_name text,
  game_type text,
  icon text,
  is_active boolean,
  is_featured boolean,
  livegameplay int,
  max_players int,
  metadata map<text, text>,
  min_players int,
  name text,
  rating double,
  status text,
  tags list<text>,
  updated_at text,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Games table with MAP and LIST types - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.leaderboard (
  game_type text,
  contest_type text,
  time_range text,
  rank int,
  avatar text,
  badge text,
  created_at timestamp,
  games_played int,
  last_played timestamp,
  level int,
  mobile_no text,
  score int,
  total_losses int,
  total_wins int,
  updated_at timestamp,
  user_id text,
  username text,
  win_rate double,
  xp int,
  PRIMARY KEY ((game_type, contest_type, time_range), rank)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Leaderboard table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.league_joins (
  user_id text,
  status_id text,
  join_month text,
  joined_at timestamp,
  entry_fee double,
  extra_data text,
  id uuid,
  invite_code text,
  league_id text,
  match_pair_id uuid,
  opponent_league_id text,
  opponent_user_id text,
  r_ip text,
  role text,
  status text,
  turn_id int,
  updated_at timestamp,
  PRIMARY KEY ((user_id, status_id, join_month), joined_at)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'League joins table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.league_joins_by_time (
  bucket_date date,
  joined_at timestamp,
  user_id text,
  extra_data text,
  league_id text,
  status text,
  PRIMARY KEY (bucket_date, joined_at, user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.TimeWindowCompactionStrategy', 'compaction_window_size': '1', 'compaction_window_unit': 'DAYS', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'League joins by time table with time-bucketed design - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.levels (
  level_no int,
  created_at timestamp,
  map_data text,
  updated_at timestamp,
  PRIMARY KEY (level_no)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Levels table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.match_pairs (
  id uuid,
  created_at timestamp,
  status text,
  updated_at timestamp,
  user1_data text,
  user1_id text,
  user2_data text,
  user2_id text,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Match pairs table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.otp_store (
  phone_or_email text,
  purpose text,
  created_at text,
  attempt_count int,
  expires_at text,
  is_verified boolean,
  otp_code text,
  PRIMARY KEY ((phone_or_email, purpose), created_at)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '10'}
  AND comment = 'OTP store table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.pending_league_joins (
  status_id text,
  join_day text,
  league_id text,
  server_id text,
  joined_at timestamp,
  contest_type text,
  extra_data text,
  game_type text,
  id uuid,
  opponent_user_id text,
  user_id text,
  PRIMARY KEY ((status_id, join_day, league_id), server_id, joined_at)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '16', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.pending_league_joins_by_status (
  user_id text,
  status_id text,
  joined_at timestamp,
  extra_data text,
  id uuid,
  league_id text,
  PRIMARY KEY ((user_id, status_id), joined_at)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Pending league joins by status table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.piece_kills (
  game_id uuid,
  piece_id uuid,
  created_at timestamp,
  killed_at timestamp,
  killed_user_id uuid,
  user_id uuid,
  PRIMARY KEY (game_id, piece_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Piece kills table with composite key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.piece_moves (
  game_id text,
  user_id text,
  piece_id uuid,
  created_at timestamp,
  current_state text,
  last_move_time timestamp,
  last_position text,
  move_history text,
  piece_metadata text,
  player_id text,
  total_moves int,
  updated_at timestamp,
  PRIMARY KEY ((game_id, user_id, piece_id))
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Piece moves table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.promoters_by_status (
  status text,
  promoter_id uuid,
  user_id uuid,
  created_at timestamp,
  metadata text,
  updated_at timestamp,
  PRIMARY KEY (status, promoter_id, user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Promoters by status table with composite key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.redis_ip_active (
  service_name text,
  ip_address text,
  port int,
  updated_at timestamp,
  PRIMARY KEY (service_name)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Redis IP active table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.reward_banners (
  id uuid,
  banner_color text,
  banner_description text,
  banner_icon text,
  banner_image text,
  banner_subtitle text,
  banner_title text,
  banner_type text,
  categories text,
  created_at timestamp,
  display_order int,
  end_date timestamp,
  extra_data text,
  full_card_image text,
  is_active boolean,
  key text,
  redeem_steps text,
  reward_amount decimal,
  reward_amount_in_word text,
  reward_amount_offer decimal,
  start_date timestamp,
  target_url text,
  updated_at timestamp,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Reward banners table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.sessions (
  user_id text,
  add_seen int,
  app_type text,
  device_id text,
  expires_at timestamp,
  fcm_token text,
  is_active boolean,
  jwt_token text,
  mobile_no text,
  session_token text,
  updated_at timestamp,
  PRIMARY KEY (user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Sessions table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.sessions_by_socket (
  socket_id text,
  created_at timestamp,
  mobile_no text,
  session_token text,
  user_id text,
  PRIMARY KEY (socket_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Sessions by socket table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.slot_machine_config (
  id int,
  config_name text,
  created_at timestamp,
  is_active boolean,
  max_bet decimal,
  min_bet decimal,
  multipliers text,
  slot_symbols text,
  updated_at timestamp,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Slot machine config table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.slot_machine_games (
  game_id uuid,
  balance_after decimal,
  balance_before decimal,
  bet_amount decimal,
  created_at timestamp,
  game_status text,
  is_free_bet boolean,
  is_win boolean,
  mobile_no text,
  multiplier int,
  session_token text,
  slot_1 text,
  slot_2 text,
  slot_3 text,
  updated_at timestamp,
  user_id uuid,
  win_amount decimal,
  PRIMARY KEY (game_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Slot machine games table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.slot_machine_stats (
  user_id uuid,
  best_streak int,
  biggest_loss decimal,
  biggest_win decimal,
  created_at timestamp,
  current_streak int,
  favorite_slot text,
  last_played_at timestamp,
  loss_count int,
  total_bet_amount decimal,
  total_games int,
  total_loss_amount decimal,
  total_win_amount decimal,
  updated_at timestamp,
  win_count int,
  worst_streak int,
  PRIMARY KEY (user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Slot machine stats table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.user_by_mobile (
  mobile_no text,
  created_at timestamp,
  user_id text,
  PRIMARY KEY (mobile_no)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'User by mobile table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.user_lifelines (
  game_id text,
  user_id text,
  chances_left int,
  created_at timestamp,
  is_active boolean,
  total_chances int,
  updated_at timestamp,
  used_chances int,
  PRIMARY KEY (game_id, user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'User lifelines table with composite key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.user_log_index (
  bucket_date date,
  event_time timestamp,
  user_id text,
  PRIMARY KEY (bucket_date, event_time, user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.TimeWindowCompactionStrategy', 'compaction_window_size': '1', 'compaction_window_unit': 'DAYS', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'User log index table with time-bucketed design - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.user_wallet (
  user_id uuid,
  affiliation decimal,
  affiliation_cr decimal,
  affiliation_db decimal,
  balance decimal,
  credit decimal,
  debit decimal,
  discount decimal,
  discount_cr decimal,
  discount_db decimal,
  fortune_sack decimal,
  fortune_sack_cr decimal,
  fortune_sack_db decimal,
  last_updated timestamp,
  metadata text,
  tds_refund decimal,
  tds_refund_cr decimal,
  tds_refund_db decimal,
  version bigint,
  win decimal,
  win_cr decimal,
  win_db decimal,
  PRIMARY KEY (user_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'User wallet table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.user_wallet_history (
  user_id uuid,
  txn_month text,
  type text,
  txn_time timestamp,
  txn_id uuid,
  affiliation decimal,
  affiliation_cr decimal,
  affiliation_db decimal,
  amount decimal,
  balance_after decimal,
  details text,
  discount decimal,
  discount_cr decimal,
  discount_db decimal,
  fortune_sack decimal,
  fortune_sack_cr decimal,
  fortune_sack_db decimal,
  metadata text,
  tds_refund decimal,
  tds_refund_cr decimal,
  tds_refund_db decimal,
  win decimal,
  win_cr decimal,
  win_db decimal,
  PRIMARY KEY ((user_id, txn_month), type, txn_time, txn_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.TimeWindowCompactionStrategy', 'compaction_window_size': '1', 'compaction_window_unit': 'DAYS', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'User wallet history table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.users (
  id text,
  avatar text,
  badge text,
  created_at timestamp,
  current_level int,
  date_of_birth timestamp,
  email text,
  full_name text,
  gender text,
  language_code text,
  language_name text,
  location text,
  mobile_no text,
  profile_data text,
  promoter_commission double,
  promoter_status text,
  refer_by uuid,
  referral_code text,
  region_code text,
  state text,
  status text,
  timezone text,
  total_games int,
  total_losses int,
  total_wins int,
  total_xp int,
  updated_at timestamp,
  user_preferences text,
  username text,
  vision_id bigint,
  win_rate double,
  PRIMARY KEY (id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': 'NONE'}
  AND comment = 'Users table - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.vision_users (
  bucket text,
  external_id bigint,
  created_at timestamp,
  email text,
  is_verified boolean,
  mobile text,
  refer_id bigint,
  refercode text,
  status text,
  updated_at timestamp,
  username text,
  users_id uuid,
  PRIMARY KEY (bucket, external_id)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Vision users table with composite key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

CREATE TABLE IF NOT EXISTS myapp.winner_declarations (
  game_id text,
  win_month text,
  user_id text,
  declared_at timestamp,
  extra_data text,
  league_id text,
  prize_amount double,
  rank int,
  score double,
  win_loss_status text,
  PRIMARY KEY ((game_id, win_month), user_id, declared_at)
) WITH
  compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}
  AND compression = {'chunk_length_in_kb': '64', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}
  AND caching = {'keys': 'ALL', 'rows_per_partition': '100'}
  AND comment = 'Winner declarations table with composite partition key - optimized for high-scale and multi-node clusters'
  AND gc_grace_seconds = 864000;

