const { config } = require('../utils/config');

// ============================================================================
// Get League IDs from Environment Config
// ============================================================================

function getLudoLeagueIds() {
  const leagueIdsStr = config.matchmaking.ludoLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}

function getSnakesLeagueIds() {
  const leagueIdsStr = config.matchmaking.snakesLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}

function getTicTacToeLeagueIds() {
  const leagueIdsStr = config.matchmaking.ticTacToeLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}

function getWaterSortLeagueIds() {
  const leagueIdsStr = config.matchmaking.waterSortLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}

module.exports = {
  getLudoLeagueIds,
  getSnakesLeagueIds,
  getTicTacToeLeagueIds,
  getWaterSortLeagueIds
};
