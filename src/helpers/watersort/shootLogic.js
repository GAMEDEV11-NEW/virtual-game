// ============================================================================
// Applies a shot/move in the Water Sort puzzle game
// ============================================================================
function applyShot(match, userId, shot) {
  let shotData = shot;
  if (typeof shot === 'string') {
    try {
      shotData = JSON.parse(shot);
    } catch (err) {
      shotData = shot;
    }
  }

  if (!shotData || typeof shotData !== 'object') {
    return { success: false, effects: {} };
  }

  const holders = shotData.holders || match.puzzle_state?.holders || {};

  if (shotData.holders && typeof shotData.holders === 'object') {
    if (!match.puzzle_state) {
      match.puzzle_state = {};
    }
    match.puzzle_state.holders = shotData.holders;
  }

  return {
    success: true,
    effects: {
      holders: holders,
      moveApplied: true,
      timestamp: new Date().toISOString()
    }
  };
}

module.exports = {
  applyShot,
};
