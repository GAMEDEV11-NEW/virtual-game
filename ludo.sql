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
  gameModeId VARCHAR(128) NULL,
  gameHistoryId VARCHAR(128) NULL,
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



create table ludo_game
(
    id                  bigint unsigned auto_increment
        primary key,
    l_id                varchar(64)                                   not null,
    opponent_l_id       varchar(64)                                   null,
    user_id             bigint unsigned                               not null,
    opponent_user_id    bigint unsigned                               null,
    contest_id          bigint unsigned                               not null,
    league_id           bigint unsigned                               not null,
    opponent_league_id  bigint unsigned                               null,
    match_id            varchar(64)                                   null,
    status              varchar(24)      default 'pending'            not null,
    status_id           tinyint unsigned default '1'                  not null,
    game_type           varchar(32)                                   null,
    contest_type        varchar(32)                                   null,
    turn_id             bigint unsigned                               null,
    winner_user_id      bigint unsigned                               null,
    join_day            date                                          not null,
    server_id           varchar(32)      default '0'                  not null,
    user_dice_id        varchar(64)                                   null,
    opponent_dice_id    varchar(64)                                   null,
    user_piece_1_id     varchar(64)                                   null,
    user_piece_2_id     varchar(64)                                   null,
    user_piece_3_id     varchar(64)                                   null,
    user_piece_4_id     varchar(64)                                   null,
    opponent_piece_1_id varchar(64)                                   null,
    opponent_piece_2_id varchar(64)                                   null,
    opponent_piece_3_id varchar(64)                                   null,
    opponent_piece_4_id varchar(64)                                   null,
    s3_key              varchar(512)                                  null,
    s3_etag             varchar(128)                                  null,
    move_count          int unsigned     default '0'                  not null,
    user_chnase         json                                          null,
    last_move_at        datetime(3)                                   null,
    lock_version        int unsigned     default '1'                  not null,
    is_deleted          tinyint(1)       default 0                    not null,
    joined_at           datetime(3)                                   not null,
    started_at          datetime(3)                                   null,
    ended_at            datetime(3)                                   null,
    created_at          datetime(3)      default CURRENT_TIMESTAMP(3) not null,
    updated_at          datetime(3)      default CURRENT_TIMESTAMP(3) not null on update CURRENT_TIMESTAMP(3),
    gameModeId          varchar(128)                                  null,
    gameHistoryId       varchar(128)                                  null,
    constraint uk_lid
        unique (l_id),
    constraint uk_match_user
        unique (match_id, user_id)
)
    charset = utf8mb4;

create index idx_match_lookup
    on ludo_game (match_id);

create index idx_opponent_lid
    on ludo_game (opponent_l_id);

create index idx_pending_scan
    on ludo_game (status_id, join_day, league_id, server_id, joined_at);

create index idx_user_lookup
    on ludo_game (user_id, contest_id, status_id);

