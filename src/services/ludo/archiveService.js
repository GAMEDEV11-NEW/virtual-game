const mysqlClient = require('../mysql/client');
const { DB_QUERIES } = require('../../constants');
const { buildGameStateKey, uploadGameStateJson } = require('../../utils/s3');

async function archiveLudoGameState(gameId, matchData, source = 'unknown') {
  if (!gameId) return null;

  const payload = (matchData && typeof matchData === 'object')
    ? matchData
    : {
      game_id: String(gameId),
      status: 'completed',
      archived_at: new Date().toISOString()
    };

  const key = buildGameStateKey('ludo', gameId, 'final');
  const upload = await uploadGameStateJson({
    key,
    payload,
    metadata: {
      game_id: String(gameId),
      source: String(source || 'unknown'),
      status: String(payload.status || 'completed')
    }
  });

  await mysqlClient.execute(DB_QUERIES.LUDO_UPDATE_ARCHIVE_BY_MATCH, [
    upload?.key || key,
    upload?.etag || '',
    'completed',
    4,
    String(gameId)
  ]);

  return upload;
}

module.exports = {
  archiveLudoGameState
};
