const { redis: redisClient } = require('../../utils/redis');
const cassandraClient = require('../cassandra/client');
const { loadPiecesIntoMatchState } = require('../../helpers/ludo/pieceMoveHelpers');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS } = require('../../constants');

const PIECE_KILLS_KEYSPACE = process.env.CASSANDRA_KEYSPACE || 'myapp';

// ============================================================================
// Ensure piece kills table exists
// ============================================================================
async function ensurePieceKillsTableExists() {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${PIECE_KILLS_KEYSPACE}.piece_kills (
        game_id text,
        piece_id text,
        user_id text,
        killed_user_id text,
        killed_at timestamp,
        created_at timestamp,
        PRIMARY KEY (game_id, piece_id, user_id)
      )
    `;
    await cassandraClient.execute(createTableQuery);
    
    try {
      await cassandraClient.execute(
        `ALTER TABLE ${PIECE_KILLS_KEYSPACE}.piece_kills ADD created_at timestamp`
      );
    } catch (alterErr) {
      if (!alterErr.message || !alterErr.message.includes('already exists')) {
      }
    }
    
    return true;
  } catch (_) { return false; }
}

// ============================================================================
// Insert kill audit record
// ============================================================================
async function insertKillAudit(gameID, killedPieceID, killerUserID, killedUserID, killedAt) {
  try {
    await ensurePieceKillsTableExists();
    await cassandraClient.execute(
      `INSERT INTO ${PIECE_KILLS_KEYSPACE}.piece_kills (game_id, piece_id, user_id, killed_user_id, killed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [gameID, killedPieceID, killedUserID, killerUserID, killedAt, new Date()],
      { prepare: true }
    );
    return true;
  } catch (err) {
    try {
      const failedData = { game_id: gameID, piece_id: killedPieceID, user_id: killedUserID, killed_user_id: killerUserID, killed_at: killedAt.toISOString(), error: err.message, timestamp: new Date().toISOString(), retry_count: 0 };
      await redisClient.rpush('failed:piece_kills', JSON.stringify(failedData));
    } catch (_) {}
    return false;
  }
}

// ============================================================================
// Update killed piece in match state
// ============================================================================
async function updateKilledPieceInMatchState(gameID, killedUserID, killedPieceID) {
  const matchKey = REDIS_KEYS.MATCH(gameID);
  const matchRaw = await redisClient.get(matchKey);
  if (!matchRaw) return null;
  let match = safeParseRedisData(matchRaw);
  if (!match) return null;
  let userPieces = null;
  if (killedUserID === match.user1_id && match.user1_pieces) userPieces = match.user1_pieces;
  else if (killedUserID === match.user2_id && match.user2_pieces) userPieces = match.user2_pieces;
  if (!userPieces) {
    const loaded = await loadPiecesIntoMatchState(gameID, killedUserID);
    if (loaded) {
      const reloadRaw = await redisClient.get(matchKey);
      if (reloadRaw) {
        match = safeParseRedisData(reloadRaw);
        if (!match) return null;
        if (killedUserID === match.user1_id && match.user1_pieces) userPieces = match.user1_pieces;
        else if (killedUserID === match.user2_id && match.user2_pieces) userPieces = match.user2_pieces;
      }
    }
  }
  if (userPieces) {
    const p = userPieces.find(pc => (pc.piece_id ?? pc.id) === killedPieceID);
    if (p) {
      const resetTarget = (match && (match.contest_type === 'quick' || match.contest_type === 'classic')) ? '1' : 'initial';
      const currentPosition = (p.to_pos_last !== undefined && p.to_pos_last !== null) ? p.to_pos_last : p.from_pos_last;
      p.from_pos_last = currentPosition;
      p.to_pos_last = resetTarget;
      p.updated_at = new Date().toISOString();
    }
  }
  await redisClient.set(matchKey, JSON.stringify(match));
  return match;
}

// ============================================================================
// Update multiple killed pieces in match state
// ============================================================================
async function updateMultipleKilledPiecesInMatchState(gameID, killedUserID, killedPieceIDs) {
  const matchKey = REDIS_KEYS.MATCH(gameID);
  const matchRaw = await redisClient.get(matchKey);
  if (!matchRaw) return null;
  let match = safeParseRedisData(matchRaw);
  if (!match) return null;
  let userPieces = null;
  if (killedUserID === match.user1_id && match.user1_pieces) userPieces = match.user1_pieces;
  else if (killedUserID === match.user2_id && match.user2_pieces) userPieces = match.user2_pieces;
  if (!userPieces) {
    const loaded = await loadPiecesIntoMatchState(gameID, killedUserID);
    if (loaded) {
      const reloadRaw = await redisClient.get(matchKey);
      if (reloadRaw) {
        match = safeParseRedisData(reloadRaw);
        if (!match) return null;
        if (killedUserID === match.user1_id && match.user1_pieces) userPieces = match.user1_pieces;
        else if (killedUserID === match.user2_id && match.user2_pieces) userPieces = match.user2_pieces;
      }
    }
  }
  if (userPieces) {
    const resetTarget = (match && (match.contest_type === 'quick' || match.contest_type === 'classic')) ? '1' : 'initial';
    killedPieceIDs.forEach(killedPieceID => {
      const p = userPieces.find(pc => (pc.piece_id ?? pc.id) === killedPieceID);
      if (p) {
        const currentPosition = (p.to_pos_last !== undefined && p.to_pos_last !== null) ? p.to_pos_last : p.from_pos_last;
        p.from_pos_last = currentPosition;
        p.to_pos_last = resetTarget;
        p.updated_at = new Date().toISOString();
      }
    });
  }
  await redisClient.set(matchKey, JSON.stringify(match));
  return match;
}

// ============================================================================
// Perform kill operation
// ============================================================================
async function performKill(io, { gameID, killerUserID, killedUserID, killedPieceID, killedPieceIDs = null }) {
  const killedAt = new Date();
  let match;
  if (killedPieceIDs && killedPieceIDs.length > 0) {
    match = await updateMultipleKilledPiecesInMatchState(gameID, killedUserID, killedPieceIDs);
    killedPieceIDs.forEach(pieceID => { insertKillAudit(gameID, pieceID, killerUserID, killedUserID, killedAt).catch(() => {}); });
  } else {
    match = await updateKilledPieceInMatchState(gameID, killedUserID, killedPieceID);
    insertKillAudit(gameID, killedPieceID, killerUserID, killedUserID, killedAt).catch(() => {});
  }
  if (!match) return { success: false };
  const nowIso = new Date().toISOString();
  match.user1_time = nowIso;
  match.user2_time = nowIso;
  match.turn = killerUserID;
  await redisClient.set(`match:${gameID}`, JSON.stringify(match));
  return { success: true, match };
}

module.exports = { performKill, updateMultipleKilledPiecesInMatchState, insertKillAudit, ensurePieceKillsTableExists };
