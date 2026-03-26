require('dotenv').config();

const {
  buildGameStateKey,
  uploadGameStateJson,
  getGameStateJson
} = require('../src/utils/s3');

async function main() {
  const matchId = process.env.S3_TEST_MATCH_ID || 'test-match-001';
  const key = buildGameStateKey('ludo', matchId, 'smoke');

  const payload = {
    game_id: matchId,
    status: 'active',
    user1_id: '1001',
    user2_id: '1002',
    turn: '1001',
    score: { user1: 0, user2: 0 },
    created_at: new Date().toISOString()
  };

  const uploadRes = await uploadGameStateJson({
    key,
    payload,
    metadata: {
      source: 'test-s3',
      game: 'ludo'
    }
  });

  const downloaded = await getGameStateJson(key);

  console.log('s3_upload_ok=', uploadRes.key);
  console.log('s3_download_ok=', downloaded.game_id === matchId);
}

main().catch((err) => {
  console.error('s3_test_error=', err.message);
  process.exit(1);
});
