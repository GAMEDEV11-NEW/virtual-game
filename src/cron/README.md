# Cron Job Configuration Guide

## Overview

Each game is handled completely separately - no common patterns or shared functions.
Each game can be modified independently without affecting others.

## File Structure

```
src/cron/
├── config.js          # Only constants/env vars (league IDs)
├── index.js           # Each game has separate implementation
└── timers/
    └── index.js       # Timer exports
```

## How It Works

### config.js - Only Constants/Env Vars

```javascript
// Only league IDs from environment config
function getLudoLeagueIds() {
  const leagueIdsStr = config.matchmaking.ludoLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}
```

### index.js - Each Game is Separate

Each game has its own complete implementation block:

```javascript
// LUDO GAME - Separate implementation
{
  const gameName = 'ludo';
  const displayName = 'Ludo';
  const matchmakingMethod = 'processMatchmakingForLeagues';
  const leagueIds = getLudoLeagueIds();
  const setServiceMethod = 'setLudoMatchmakingService';
  const startTimerMethod = 'startLudoUserTimerCron';
  const stopTimerMethod = 'stopLudoUserTimerCron';
  
  let ludoMatchmakingService = null;
  let ludoTimerId = null;
  
  // ... complete separate implementation
  registry.register(gameName, {
    startMatchmaking: async (intervalMs) => {
      // Ludo-specific code here
    },
    stopMatchmaking: () => {
      // Ludo-specific code here
    },
    startUserTimers: (intervalMs) => {
      // Ludo-specific code here
    },
    stopUserTimers: () => {
      // Ludo-specific code here
    }
  });
}
```

## Add New Game

### Step 1: Add league IDs function in config.js

```javascript
function getNewGameLeagueIds() {
  const leagueIdsStr = config.matchmaking.newGameLeagueIds || '';
  return leagueIdsStr.split(',').map(id => id.trim()).filter(id => id);
}

module.exports = {
  // ... existing exports
  getNewGameLeagueIds
};
```

### Step 2: Add separate game block in index.js

In `registerAllGames()` function, add a new separate block:

```javascript
// NEW GAME - Separate implementation
{
  const gameName = 'newgame';
  const displayName = 'New Game';
  const matchmakingMethod = 'processNewGameMatchmaking';
  const leagueIds = getNewGameLeagueIds();
  const setServiceMethod = 'setNewGameMatchmakingService';
  const startTimerMethod = 'startNewGameUserTimerCron';
  const stopTimerMethod = 'stopNewGameUserTimerCron';
  
  let newgameMatchmakingService = null;
  let newgameTimerId = null;
  
  const timerModule = require('./timers');
  const setNewgameService = timerModule[setServiceMethod];
  const startNewgameTimer = timerModule[startTimerMethod];
  const stopNewgameTimer = timerModule[stopTimerMethod];
  
  if (!setNewgameService || !startNewgameTimer || !stopNewgameTimer) {
    console.error(`❌ [${displayName}] Methods not found`);
  } else {
    registry.register(gameName, {
      startMatchmaking: async (intervalMs) => {
        if (newgameTimerId) return;
        
        // Import game-specific matchmaking service
        const { NewGameMatchmakingService } = require('./matchmaking/newgame');
        newgameMatchmakingService = new NewGameMatchmakingService(session);
        setNewgameService(newgameMatchmakingService);
        
        newgameTimerId = setInterval(() => {
          newgameMatchmakingService.processNewGameMatchmaking(leagueIds).catch((err) => {
            console.error(`[${displayName} Matchmaking] Error:`, err.message);
          });
        }, intervalMs);
        
        console.log(`✅ [${displayName}] Matchmaking started (${intervalMs}ms)`);
      },
      stopMatchmaking: () => {
        if (newgameTimerId) {
          clearInterval(newgameTimerId);
          newgameTimerId = null;
          console.log(`⏹️  [${displayName}] Matchmaking stopped`);
        }
      },
      startUserTimers: (intervalMs) => {
        startNewgameTimer(intervalMs);
      },
      stopUserTimers: () => {
        stopNewgameTimer();
      }
    });
    
    console.log(`📝 [${displayName}] Registered`);
  }
}
```

## Benefits

- ✅ **Independent**: Each game is completely separate
- ✅ **Flexible**: Modify one game without affecting others
- ✅ **Clear**: All code for each game in one place
- ✅ **No Dependencies**: No common patterns to break
- ✅ **Easy**: Just copy a game block and modify it

## Usage

```javascript
const { initializeCronService } = require('./src/cron');
await initializeCronService(io);
```

## Related Files

- `src/utils/config.js` - Environment variables
- `src/constants/index.js` - Timer intervals
- `src/cron/matchmaking/` - Game-specific matchmaking services
  - `ludo.js` - Ludo matchmaking service
  - `snakes.js` - Snakes & Ladders matchmaking service
  - `tictactoe.js` - TicTacToe matchmaking service
  - `watersort.js` - Water Sort matchmaking service
