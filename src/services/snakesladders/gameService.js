const cassandraClient = require('../cassandra/client');

// ============================================================================
// Update match pair status
// ============================================================================
async function updateMatchPairStatus(gameId, status) {
  try {
    const query = `
      UPDATE match_pairs 
      SET status = ?, updated_at = ?
      WHERE id = ?
    `;
    
    const result = await cassandraClient.execute(query, [
      status,
      new Date(),
      gameId
    ], { prepare: true });
    
    return result;
  } catch (error) {
    throw error;
  }
}

module.exports = {
  updateMatchPairStatus
};
