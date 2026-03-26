# Socket Game Server - Complete Documentation

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [System Architecture](#system-architecture)
3. [Application Flow](#application-flow)
4. [Installation & Setup](#installation--setup)
5. [Project Structure](#project-structure)
6. [Configuration](#configuration)
7. [Games Supported](#games-supported)
8. [Core Components](#core-components)
9. [Data Flow](#data-flow)
10. [Cron Jobs & Timers](#cron-jobs--timers)
11. [Socket Events](#socket-events)
12. [Database Schema](#database-schema)
13. [Redis Keys & Data Structure](#redis-keys--data-structure)
14. [Error Handling](#error-handling)
15. [Utility Functions](#utility-functions)
16. [Security](#security)
17. [Deployment](#deployment)
18. [Troubleshooting](#troubleshooting)

---

## 🎮 Project Overview

This is a **real-time multiplayer game server** built with Node.js, Socket.IO, Fastify, Apache Cassandra, and Redis. It supports four board games: **Ludo**, **Snakes & Ladders**, **Tic-Tac-Toe**, and **Water Sort Puzzle**.

### Key Features

- ✅ Real-time multiplayer gameplay via WebSocket (Socket.IO)
- ✅ Automatic matchmaking system
- ✅ Turn-based timer management
- ✅ Wallet integration with transaction logging
- ✅ Winner declaration and prize distribution
- ✅ Disconnect/reconnect handling
- ✅ Session management with Redis
- ✅ JWT-based authentication
- ✅ Cron jobs for automated game management

### Technology Stack

- **Runtime**: Node.js (v18+)
- **Web Framework**: Fastify
- **Real-time Communication**: Socket.IO v4
- **Database**: Apache Cassandra
- **Cache/Session Store**: Redis (with username support for Redis 6.0+ ACL)
- **Authentication**: JWT (jsonwebtoken)

---

## 🏗️ System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                     │
│                    (Browser/Mobile App)                     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        │ WebSocket (Socket.IO)
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                    Fastify HTTP Server                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Socket.IO Server                        │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │         Authentication Middleware              │  │   │
│  │  │         (JWT Token Validation)                 │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │         Game Handlers                          │  │   │
│  │  │  • Ludo Handlers                               │  │   │
│  │  │  • Snakes & Ladders Handlers                   │  │   │
│  │  │  • Tic-Tac-Toe Handlers                        │  │   │
│  │  │  • Water Sort Handlers                         │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │         Services Layer                         │  │   │
│  │  │  • Game Services                               │  │   │
│  │  │  • Winner Declaration Service                  │  │   │
│  │  │  • Wallet Service                              │  │   │
│  │  │  • Session Service                             │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Cron Jobs (Background Tasks)                 │   │
│  │  • Matchmaking Cron (every 2 seconds)                │   │
│  │  • Timer Cron (every 1 second)                       │   │
│  │  • Game State Management                             │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────┬───────────────────────────┬─────────────────┘
                │                           │
                │                           │
    ┌───────────▼──────────┐    ┌──────────▼──────────┐
    │      Redis           │    │     Cassandra        │
    │  • Match Data        │    │  • User Data        │
    │  • Session Data      │    │  • Match Pairs      │
    │  • Socket Mappings   │    │  • Transactions      │
    │  • User Chances      │    │  • Winner Records   │
    └──────────────────────┘    └──────────────────────┘
```

### Component Interaction Flow

```
1. Client Connection
   └─> Socket.IO Connection
       └─> Authentication Middleware (JWT Validation)
           └─> Session Creation/Update
               └─> Socket Registration
                   └─> Handler Registration

2. Game Request
   └─> Handler Receives Event
       └─> Authentication Check
           └─> Data Validation
               └─> Redis Match Data Fetch
                   └─> Game Logic Processing
                       └─> Redis Update
                           └─> Response to Client
                               └─> Opponent Notification

3. Matchmaking (Cron)
   └─> Query Pending Users
       └─> Match Users
           └─> Create Match Pair
               └─> Initialize Game in Redis
                   └─> Notify Both Users

4. Timer Management (Cron)
   └─> Fetch Active Games
       └─> Update Timers
           └─> Check Timeouts
               └─> Declare Winner (if timeout)
                   └─> Update Wallet
                       └─> Cleanup Redis
```

---

## 🔄 Application Flow

### 1. Server Startup Flow

```
server.js
  ├─> Load Environment Variables (.env)
  ├─> Initialize Fastify Server
  ├─> Initialize Socket.IO Server
  ├─> Register Socket Authentication Middleware
  ├─> Register Socket Handlers (all games)
  ├─> Initialize Cassandra Client
  ├─> Initialize Redis Client
  ├─> Initialize Cron Service
  │   ├─> Start Matchmaking Cron (Ludo, Snakes, TicTacToe, WaterSort)
  │   └─> Start Timer Cron (Ludo, Snakes, TicTacToe, WaterSort)
  └─> Start HTTP Server
```

### 2. Client Connection Flow

```
Client Connects
  ├─> Socket.IO Handshake
  ├─> Authentication Middleware (socketAuth.js)
  │   ├─> Extract JWT Token
  │   ├─> Validate JWT Token
  │   ├─> Check Existing Session
  │   ├─> Disconnect Old Socket (if exists)
  │   ├─> Update Session with New Socket ID
  │   ├─> Store Socket-to-User Mapping (Redis)
  │   ├─> Store User-to-Socket Mapping (Redis)
  │   └─> Attach User to Socket Object
  ├─> Connection Established Event
  └─> Register Game Handlers
      ├─> Ludo Handlers
      ├─> Snakes & Ladders Handlers
      ├─> Tic-Tac-Toe Handlers
      └─> Water Sort Handlers
```

### 3. Game Matchmaking Flow

```
Matchmaking Cron (Every 2 seconds)
  ├─> Query Pending League Joins (Cassandra)
  │   └─> SELECT * FROM league_joins WHERE status_id = '1'
  ├─> Group by League ID
  ├─> Match Users (2 players per match)
  ├─> For Each Match:
  │   ├─> Create Match Pair (Cassandra)
  │   ├─> Update League Joins Status
  │   ├─> Initialize Game State in Redis
  │   │   ├─> Match Data
  │   │   ├─> User Chances
  │   │   └─> Timer Data
  │   ├─> Store Session in Redis
  │   ├─> Get Socket IDs from Redis
  │   └─> Emit Match Found Event to Both Users
  └─> Handle Expired Matches
```

### 4. Game Play Flow (Example: Ludo)

```
Player Action (e.g., Dice Roll)
  ├─> Client Emits: 'dice:roll'
  ├─> Handler Receives Event
  │   ├─> Authenticate User
  │   ├─> Validate Game ID
  │   ├─> Fetch Match from Redis
  │   ├─> Validate Turn
  │   ├─> Roll Dice
  │   ├─> Update Match in Redis
  │   ├─> Update Timer
  │   └─> Emit Response to Player
  └─> Notify Opponent
      └─> Emit Update Event
```

### 5. Timer Management Flow

```
Timer Cron (Every 1 second)
  ├─> Scan Active Games (Redis)
  ├─> For Each Active Game:
  │   ├─> Fetch Match Data
  │   ├─> Calculate Elapsed Time
  │   ├─> Update User Timers
  │   ├─> Check for Timeout
  │   │   ├─> If Timeout:
  │   │   │   ├─> Declare Opponent as Winner
  │   │   │   ├─> Update Wallet
  │   │   │   ├─> Record Transaction
  │   │   │   ├─> Update Match Status
  │   │   │   └─> Cleanup Redis
  │   │   └─> If Not Timeout:
  │   │       └─> Emit Timer Update to Players
  │   └─> Handle Turn Changes
  └─> Handle Game Completion
```

### 6. Winner Declaration Flow

```
Winner Declaration Trigger
  ├─> Game Completion Detected
  │   ├─> Normal Win (all pieces home, etc.)
  │   ├─> Timeout Win
  │   └─> Opponent Quit
  ├─> Winner Declaration Service
  │   ├─> Get League Join Info
  │   ├─> Calculate Prize Amount
  │   ├─> Credit Winner Wallet
  │   ├─> Record Transaction
  │   ├─> Insert Winner Declaration (Cassandra)
  │   ├─> Update Match Pair Status
  │   ├─> Mark Game as Complete
  │   └─> Cleanup Redis Data
  └─> Notify Players
      └─> Emit Game End Event
```

### 7. Disconnect/Reconnect Flow

```
Client Disconnects
  ├─> Disconnect Handler Triggered
  ├─> Update Session (Cassandra)
  │   └─> Mark as Disconnected
  ├─> Cleanup Redis Mappings
  │   ├─> Remove socket_to_user mapping
  │   └─> Remove user_to_socket mapping
  ├─> Cleanup Timer Handlers
  │   └─> Clear Interval Timers
  └─> Handle Active Game
      ├─> If Game Active:
      │   ├─> Update Match Status
      │   └─> Notify Opponent
      └─> If Searching for Match:
          └─> Cancel Matchmaking

Client Reconnects
  ├─> New Socket Connection
  ├─> Authentication (same JWT)
  ├─> Old Socket Disconnected
  ├─> New Socket Mappings Created
  └─> Resume Game (if active)
```

---

## 🚀 Installation & Setup

### Prerequisites

- Node.js (v18 or higher)
- Redis Server (v6.0+ for username support)
- Apache Cassandra
- npm or yarn

### Installation Steps

1. **Clone the repository**
```bash
git clone <repository-url>
cd SOCKET_CRON
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Redis Configuration (Primary)
REDIS_URL=127.0.0.1:6379
REDIS_USERNAME=                    # Optional: for Redis 6.0+ ACL
REDIS_PASSWORD=                     # Optional: if password required
REDIS_DB=0

# Redis Configuration (Cache) - Optional
REDIS_CACHE_URL=
REDIS_CACHE_USERNAME=
REDIS_CACHE_PASSWORD=
REDIS_CACHE_DB=1

# Redis Configuration (Session) - Optional
REDIS_SESSION_URL=
REDIS_SESSION_USERNAME=
REDIS_SESSION_PASSWORD=
REDIS_SESSION_DB=2

# Cassandra Configuration
CASSANDRA_HOST=127.0.0.1
CASSANDRA_PORT=9042
CASSANDRA_KEYSPACE=myapp
CASSANDRA_USERNAME=cassandra
CASSANDRA_PASSWORD=cassandra
CASSANDRA_LOCAL_DATACENTER=datacenter1

# JWT Configuration
JWT_SECRET=your-secret-key-here
JWT_EXPIRY=24h

# Socket.IO Configuration
SOCKET_CORS_ORIGIN=http://localhost:3000

# Matchmaking League IDs
LUDO_LEAGUE_IDS=1,2,3,4,5,6,7,8,9,10,11,12
SNAKES_LADDERS_LEAGUE_IDS=13,14,15
TICTACTOE_LEAGUE_IDS=16,17,18
WATERSORT_LEAGUE_IDS=19,20,21
```

4. **Start Redis**
```bash
redis-server
```

5. **Start Cassandra**
```bash
# Follow Cassandra installation guide for your OS
```

6. **Initialize Database**
```bash
# Create keyspace and tables (see Database Schema section)
```

7. **Start the server**
```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Health Check Endpoints

The server provides two HTTP endpoints for monitoring:

**`GET /health`**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 12345,
  "services": {
    "socket": 10,
    "cassandra": "connected",
    "redis": "connected"
  }
}
```

**`GET /socket-status`**
```json
{
  "totalConnections": 10,
  "authenticatedConnections": 8,
  "connections": [
    {
      "id": "socket-id",
      "userId": "user-id",
      "connected": true
    }
  ]
}
```

---

## 📁 Project Structure

```
SOCKET_CRON/
├── src/
│   ├── config/                      # Game configuration files
│   │   ├── gameConfig.js            # General game settings
│   │   ├── scoreConfig.js           # Scoring rules
│   │   ├── snakesladdersConfig.js   # Snakes & Ladders config
│   │   └── watersortConfig.js       # Water Sort config
│   │
│   ├── constants/                  # Application constants
│   │   └── index.js                # All constants (GAME_STATUS, REDIS_KEYS, etc.)
│   │
│   ├── handlers/                   # Socket event handlers
│   │   ├── common/                 # Common/base handlers
│   │   │   └── baseHandlers.js    # Base handler utilities
│   │   ├── ludo/                   # Ludo game handlers
│   │   │   ├── register.js        # Handler registration
│   │   │   ├── diceRollHandler.js
│   │   │   ├── pieceMoveHandler.js
│   │   │   ├── quitGameHandler.js
│   │   │   ├── disconnectHandler.js
│   │   │   └── timerUpdateHandler.js
│   │   ├── snakesladders/         # Snakes & Ladders handlers
│   │   ├── tictactoe/             # Tic-Tac-Toe handlers
│   │   └── watersort/             # Water Sort handlers
│   │
│   ├── services/                   # Business logic services
│   │   ├── cassandra/             # Cassandra client
│   │   │   └── client.js
│   │   ├── common/                 # Common services
│   │   │   ├── baseWindeclearService.js  # Winner declaration
│   │   │   └── walletService.js    # Wallet operations
│   │   ├── ludo/                   # Ludo-specific services
│   │   │   ├── gameService.js
│   │   │   ├── scoreService.js
│   │   │   ├── killService.js
│   │   │   ├── homeReachService.js
│   │   │   └── windeclearService.js
│   │   ├── snakesladders/
│   │   ├── tictactoe/
│   │   └── watersort/
│   │
│   ├── helpers/                    # Helper functions
│   │   ├── common/                 # Common helpers
│   │   │   └── gameHelpers.js
│   │   ├── ludo/                   # Ludo-specific helpers
│   │   │   ├── diceRollHelpers.js
│   │   │   ├── pieceMoveHelpers.js
│   │   │   └── moveRules.js
│   │   ├── snakesladders/
│   │   └── watersort/
│   │
│   ├── utils/                      # Utility functions
│   │   ├── redis.js                # Redis client & utilities
│   │   ├── config.js               # Configuration loader
│   │   ├── jwt.js                  # JWT utilities
│   │   ├── sessionService.js      # Session management
│   │   ├── authUtils.js            # Authentication utilities
│   │   ├── dateUtils.js            # Date utilities
│   │   ├── matchUtils.js           # Match utilities
│   │   ├── dataUtils.js            # Data transformation
│   │   ├── errorHandler.js         # Error handling
│   │   ├── gameUtils.js            # Game utilities
│   │   ├── timer.js                # Timer utilities
│   │   └── ...                     # Other utilities
│   │
│   ├── middleware/                 # Middleware
│   │   ├── socketAuth.js          # Socket authentication
│   │   └── withAuth.js            # Auth wrapper
│   │
│   ├── routes/                     # Route handlers
│   │   └── socketRoutes.js        # Socket route registration
│   │
│   ├── cron/                       # Cron jobs
│   │   ├── index.js               # Cron scheduler
│   │   ├── config.js              # Cron configuration
│   │   ├── matchmaking/           # Matchmaking services
│   │   │   ├── ludo.js
│   │   │   ├── snakes.js
│   │   │   ├── tictactoe.js
│   │   │   └── watersort.js
│   │   ├── timers/                # Timer cron jobs
│   │   │   ├── index.js
│   │   │   ├── ludo.js
│   │   │   ├── snakes.js
│   │   │   ├── tictactoe.js
│   │   │   └── watersort.js
│   │   └── services/              # Cron services
│   │       ├── piecesService.js
│   │       └── winnerService.js
│   │
│   └── server.js                   # Main server entry point
│
├── package.json
├── .env                            # Environment variables
└── README.md                       # This file
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | `3000` | No |
| `HOST` | Server host | `0.0.0.0` | No |
| `REDIS_URL` | Redis connection URL | `127.0.0.1:6379` | Yes |
| `REDIS_USERNAME` | Redis username (Redis 6.0+ ACL) | `` | No |
| `REDIS_PASSWORD` | Redis password | `` | No |
| `REDIS_DB` | Redis database number | `0` | No |
| `CASSANDRA_HOST` | Cassandra host | `127.0.0.1` | Yes |
| `CASSANDRA_PORT` | Cassandra port | `9042` | Yes |
| `CASSANDRA_KEYSPACE` | Cassandra keyspace | `myapp` | Yes |
| `CASSANDRA_USERNAME` | Cassandra username | `cassandra` | No |
| `CASSANDRA_PASSWORD` | Cassandra password | `cassandra` | No |
| `JWT_SECRET` | JWT secret key | - | Yes |
| `SOCKET_CORS_ORIGIN` | CORS origin for Socket.IO | `*` | No |
| `LUDO_LEAGUE_IDS` | Comma-separated league IDs for Ludo | - | Yes |
| `SNAKES_LADDERS_LEAGUE_IDS` | League IDs for Snakes & Ladders | - | Yes |
| `TICTACTOE_LEAGUE_IDS` | League IDs for Tic-Tac-Toe | - | Yes |
| `WATERSORT_LEAGUE_IDS` | League IDs for Water Sort | - | Yes |

### Redis Configuration

The application supports multiple Redis connections:

1. **Primary Redis** (`REDIS_URL`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DB`)
   - Used for match data, game state
   - Default connection

2. **Cache Redis** (Optional)
   - Used for caching (if configured)
   - Variables: `REDIS_CACHE_URL`, `REDIS_CACHE_USERNAME`, `REDIS_CACHE_PASSWORD`, `REDIS_CACHE_DB`

3. **Session Redis** (Optional)
   - Used for session storage (if configured)
   - Variables: `REDIS_SESSION_URL`, `REDIS_SESSION_USERNAME`, `REDIS_SESSION_PASSWORD`, `REDIS_SESSION_DB`

**Note**: Username support is optional and only used if provided. If not provided, the connection uses password-only authentication (backward compatible).

---

## 🎯 Games Supported

### 1. Ludo
- **Type**: Board game
- **Players**: 2
- **Duration**: 5 minutes (300 seconds)
- **Turn Timer**: 15 seconds
- **Max Chances**: 3 per player
- **Features**: 
  - Dice rolling
  - Piece movement
  - Piece kills
  - Home reach detection
  - Winner: First to get all 4 pieces home

### 2. Snakes & Ladders
- **Type**: Board game
- **Players**: 2
- **Duration**: 10 minutes (600 seconds)
- **Turn Timer**: 15 seconds
- **Max Chances**: 3 per player
- **Features**:
  - Dice rolling
  - Piece movement
  - Automatic snake/ladder handling
  - Winner: First to reach position 100

### 3. Tic-Tac-Toe
- **Type**: Strategy game
- **Players**: 2
- **Duration**: 5 minutes (300 seconds)
- **Turn Timer**: 60 seconds
- **Max Chances**: 1 per player per turn
- **Features**:
  - Grid-based moves (3x3)
  - Win detection (3 in a row)
  - Draw detection
  - Winner: First to get 3 in a row

### 4. Water Sort Puzzle
- **Type**: Puzzle game
- **Players**: 2 (simultaneous play)
- **Duration**: 5 minutes (300 seconds)
- **Timer**: 5 minutes per player (independent)
- **Max Chances**: 1 per player
- **Features**:
  - Color sorting
  - Level progression
  - Simultaneous play
  - Winner: First to complete puzzle

---

## 🔧 Core Components

### 1. Server (`src/server.js`)

Main entry point that:
- Initializes Fastify HTTP server
- Sets up Socket.IO server
- Registers authentication middleware
- Registers all game handlers
- Initializes Cassandra and Redis
- Starts cron services
- Provides health check endpoints

### 2. Authentication (`src/middleware/socketAuth.js`)

JWT-based authentication middleware that:
- Validates JWT token on connection
- Manages single connection per user
- Creates/updates session
- Stores socket-to-user mappings in Redis
- Attaches user data to socket object

### 3. Socket Handlers

Each game has its own handlers:
- **Check Opponent Handler** (Ludo, Snakes & Ladders): Checks if opponent has joined and initializes game pieces
- **Dice Roll Handler**: Handles dice rolling
- **Piece Move Handler**: Handles piece movements
- **Quit Game Handler**: Handles game quitting
- **Disconnect Handler**: Handles disconnections
- **Timer Update Handler**: Handles timer updates

### 4. Matchmaking Service (`src/cron/matchmaking/`)

Background service that:
- Queries pending league joins from Cassandra
- Matches players (2 per match)
- Creates match pairs
- Initializes game state in Redis
- Notifies players when match is found

### 5. Timer Service (`src/cron/timers/`)

Background service that:
- Monitors active games every second
- Updates game timers
- Detects timeouts
- Declares winners on timeout
- Emits timer updates to players

### 6. Winner Declaration Service (`src/services/common/baseWindeclearService.js`)

Service that:
- Calculates prize amounts
- Credits winner wallet
- Records transactions
- Inserts winner declarations
- Updates match status
- Cleans up Redis data

### 7. Winner Declaration Service (Atomic) (`src/cron/services/winnerService.js`)

Atomic winner declaration service that:
- Prevents duplicate winner declarations
- Uses distributed locks (Redis SETNX)
- Tracks declared winners in-memory
- Handles multi-instance deployments safely

### 8. Game Pieces Service (`src/cron/services/piecesService.js`)

Service that:
- Creates game pieces for matches
- Retrieves user pieces
- Manages piece state
- Handles piece creation for Ludo and Snakes & Ladders

### 9. Redis Service (`src/utils/redis.js`)

Redis client wrapper that:
- Manages multiple Redis connections
- Provides utility functions for match data
- Handles retry logic
- Supports atomic operations
- Manages TTL

---

## 📊 Data Flow

### Match Data Flow

```
1. Matchmaking Creates Match
   └─> Cassandra: INSERT match_pairs
   └─> Redis: SET match:{gameId} (with TTL 24h)

2. Game Play Updates
   └─> Handler: GET match:{gameId}
   └─> Handler: Process game logic
   └─> Handler: SET match:{gameId} (updated state)

3. Timer Cron Reads
   └─> Timer: GET match:{gameId}
   └─> Timer: Update timers
   └─> Timer: SET match:{gameId} (if changed)

4. Game Completion
   └─> Winner Service: GET match:{gameId}
   └─> Winner Service: Process winner
   └─> Winner Service: DEL match:{gameId}
   └─> Cassandra: UPDATE match_pairs status
```

### Session Data Flow

```
1. Client Connects
   └─> Auth Middleware: Validate JWT
   └─> Session Service: GET session:{token}
   └─> Session Service: SET session:{token} (with socket_id)
   └─> Redis: SET socket_to_user:{socketId} = userId
   └─> Redis: SET user_to_socket:{userId} = socketId

2. Client Disconnects
   └─> Disconnect Handler: DEL socket_to_user:{socketId}
   └─> Disconnect Handler: DEL user_to_socket:{userId}
   └─> Session Service: UPDATE session (remove socket_id)
```

### User Chances Flow

```
1. Game Initialization
   └─> Matchmaking: SET userchance:{gameId} = {user1: 3, user2: 3}

2. Turn Processing
   └─> Handler: GET userchance:{gameId}
   └─> Handler: Decrement chance
   └─> Handler: SET userchance:{gameId} (updated)

3. Timer Cron
   └─> Timer: GET userchance:{gameId}
   └─> Timer: Check if chances exhausted
   └─> Timer: Declare winner if needed

4. Game Completion
   └─> Winner Service: DEL userchance:{gameId}
```

---

## ⏰ Cron Jobs & Timers

### Cron System Architecture

The cron system consists of **two types of background jobs** running independently for each game:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cron Service (src/cron/index.js)             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Matchmaking Cron Jobs (Every 2 seconds)                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │  │
│  │  │  Ludo    │  │  Snakes  │  │ TicTacToe│  │WaterSort│ │  │
│  │  │ Matchmk  │  │ Matchmk  │  │ Matchmk  │  │ Matchmk │ │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Timer Cron Jobs (Every 1 second)                        │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │  │
│  │  │  Ludo    │  │  Snakes  │  │ TicTacToe│  │WaterSort│ │  │
│  │  │  Timer   │  │  Timer   │  │  Timer   │  │  Timer  │ │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐
    │Cassandra│          │  Redis  │          │Socket.IO│
    │Database │          │  Cache  │          │ Server  │
    └─────────┘          └─────────┘          └─────────┘
```

### Matchmaking Cron Flow

**Frequency**: Every 2 seconds (`TIMER_CONSTANTS.MATCHMAKING_TICK = 2000ms`)

**Detailed Flow Diagram**:

```
┌─────────────────────────────────────────────────────────────────┐
│              MATCHMAKING CRON (Every 2 seconds)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  Query Pending League Joins         │
        │  FROM pending_league_joins          │
        │  WHERE status_id = '1' (pending)     │
        │  AND join_day = today/yesterday     │
        │  AND league_id IN (leagueIds)       │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Filter & Group Users               │
        │  • Remove expired (>10s old)        │
        │  • Group by league_id               │
        │  • Group by game_type               │
        │  • Group by contest_type            │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Match Users (2 per match)          │
        │  • Find pairs with same:            │
        │    - league_id                      │
        │    - game_type                      │
        │    - contest_type                   │
        │  • Skip if already matched          │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Create Match Pair                  │
        │  • INSERT INTO match_pairs           │
        │  • Generate match_pair_id (UUID)    │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Initialize Game State              │
        │  • Create game pieces               │
        │  • Create dice rolls                │
        │  • Initialize user chances          │
        │  • Set initial game state           │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Store in Redis                     │
        │  • SET match:{gameId} = matchData   │
        │  • SET userchance:{gameId} = {...}  │
        │  • TTL: 24 hours                    │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Update League Joins                │
        │  • UPDATE league_joins               │
        │    SET status = 'matched'            │
        │    SET opponent_user_id = ...        │
        │    SET match_pair_id = ...           │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Cleanup Pending Joins              │
        │  • DELETE FROM pending_league_joins │
        │  • DELETE FROM                      │
        │    pending_league_joins_by_status   │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Get Socket IDs                     │
        │  • GET user_to_socket:{user1Id}     │
        │  • GET user_to_socket:{user2Id}     │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  Notify Players                     │
        │  • Emit 'match:found' to user1      │
        │  • Emit 'match:found' to user2      │
        │  • Include match data               │
        └─────────────────────────────────────┘
```

**Matchmaking Process Steps**:

1. **Query Pending Users**
   - Query `pending_league_joins` table
   - Filter by status `'1'` (pending)
   - Check today and yesterday (to catch late matches)
   - Filter by configured league IDs

2. **Filter & Validate**
   - Remove users who joined >10 seconds ago (expired)
   - Group users by:
     - `league_id`
     - `game_type`
     - `contest_type`

3. **Match Users**
   - Pair users with matching criteria
   - Skip if user already matched in this cycle
   - Create pairs sequentially

4. **Create Match**
   - Insert into `match_pairs` table
   - Generate unique `match_pair_id` (UUID)
   - Create game pieces (for Ludo/Snakes)
   - Initialize dice rolls
   - Set up user chances

5. **Store in Redis**
   - Store match data: `match:{gameId}`
   - Store user chances: `userchance:{gameId}`
   - Set TTL: 24 hours

6. **Update Database**
   - Update `league_joins` status to `'matched'`
   - Set opponent information
   - Link to `match_pair_id`

7. **Cleanup**
   - Delete from `pending_league_joins`
   - Delete from `pending_league_joins_by_status`

8. **Notify Players**
   - Get socket IDs from Redis
   - Emit match found event to both players

**Games**: Ludo, Snakes & Ladders, Tic-Tac-Toe, Water Sort

### Timer Cron Flow

**Frequency**: Every 1 second (`TIMER_CONSTANTS.USER_TIMER_TICK = 1000ms`)

**Detailed Flow Diagram**:

```
┌─────────────────────────────────────────────────────────────────┐
│              TIMER CRON (Every 1 second)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  Get Active Games from Redis         │
        │  • SCAN match:{gameId} patterns      │
        │  • Or use matchmaking service        │
        │    to get active game IDs           │
        └──────────────┬──────────────────────┘
                       │
                       ▼
        ┌─────────────────────────────────────┐
        │  For Each Active Game:              │
        │  ┌──────────────────────────────┐  │
        │  │ 1. Fetch Match Data          │  │
        │  │    GET match:{gameId}         │  │
        │  └──────────────┬───────────────┘  │
        │                 │                   │
        │                 ▼                   │
        │  ┌──────────────────────────────┐  │
        │  │ 2. Validate Match            │  │
        │  │    • Check if exists         │  │
        │  │    • Check status = 'active' │  │
        │  │    • Check if completed      │  │
        │  └──────────────┬───────────────┘  │
        │                 │                   │
        │                 ▼                   │
        │  ┌──────────────────────────────┐  │
        │  │ 3. Fetch User Chances        │  │
        │  │    GET userchance:{gameId}   │  │
        │  └──────────────┬───────────────┘  │
        │                 │                   │
        │                 ▼                   │
        │  ┌──────────────────────────────┐  │
        │  │ 4. Calculate Timers          │  │
        │  │    • Calculate elapsed time   │  │
        │  │    • Calculate remaining     │  │
        │  │    • Update user timers      │  │
        │  └──────────────┬───────────────┘  │
        │                 │                   │
        │                 ▼                   │
        │  ┌──────────────────────────────┐  │
        │  │ 5. Check Timeout             │  │
        │  │    • If user timer <= 0      │  │
        │  │    • If game time expired     │  │
        │  │    • If chances exhausted    │  │
        │  └──────────────┬───────────────┘  │
        │                 │                   │
        │        ┌────────┴────────┐          │
        │        │                 │          │
        │        ▼                 ▼          │
        │  ┌──────────┐    ┌──────────────┐  │
        │  │ Timeout? │ NO │ 6. Update     │  │
        │  │          │───▶│    Timers    │  │
        │  └────┬─────┘    │    in Redis  │  │
        │       │ YES      └──────┬───────┘  │
        │       │                 │          │
        │       ▼                 ▼          │
        │  ┌──────────────┐  ┌──────────────┐│
        │  │ 7. Declare   │  │ 8. Emit      ││
        │  │    Winner    │  │    Timer    ││
        │  │    (Timeout) │  │    Update   ││
        │  └──────┬───────┘  └──────┬───────┘│
        │         │                 │        │
        │         ▼                 ▼        │
        │  ┌──────────────────────────────┐  │
        │  │ 9. Update Wallet            │  │
        │  │ 10. Record Transaction      │  │
        │  │ 11. Insert Winner Record    │  │
        │  │ 12. Cleanup Redis            │  │
        │  └──────────────────────────────┘  │
        └─────────────────────────────────────┘
```

**Timer Process Steps**:

1. **Get Active Games**
   - Get list of active game IDs from matchmaking service
   - Or scan Redis for active match keys

2. **Fetch Match Data**
   - For each game: `GET match:{gameId}` from Redis
   - Parse JSON match data

3. **Validate Match**
   - Check if match exists
   - Check if status is `'active'`
   - Skip if already completed

4. **Fetch User Chances**
   - `GET userchance:{gameId}` from Redis
   - Get current chance counts for both users

5. **Calculate Timers**
   - Calculate elapsed time since game start
   - Calculate remaining game time
   - Update user-specific timers (turn timers)
   - Decrement timers based on elapsed time

6. **Check Timeout Conditions**
   - **User Timer Timeout**: If current player's timer <= 0
   - **Game Time Expired**: If total game time expired
   - **Chances Exhausted**: If user has no chances left

7. **Handle Timeout** (if timeout detected)
   - Declare opponent as winner
   - Update match status to `'completed'`
   - Call winner declaration service

8. **Update Timers** (if no timeout)
   - Update match data in Redis with new timer values
   - Update user chances if needed

9. **Emit Timer Updates**
   - Get socket IDs for both players
   - Emit `timer:update` event to both players
   - Include current timer values, scores, chances

10. **Winner Declaration** (if timeout)
    - Credit winner wallet
    - Record transaction
    - Insert winner declaration record
    - Update match pair status
    - Cleanup Redis data

**Games**: Ludo, Snakes & Ladders, Tic-Tac-Toe, Water Sort

### Cron System Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    CRON SYSTEM INTERACTIONS                     │
└─────────────────────────────────────────────────────────────────┘

    ┌──────────────┐                    ┌──────────────┐
    │  Server      │                    │  Matchmaking│
    │  Startup     │──initializeCron()──▶│  Cron       │
    └──────────────┘                    │  (2s tick)  │
                                        └──────┬───────┘
                                               │
                                               ▼
                                    ┌──────────────────┐
                                    │  Query Cassandra │
                                    │  pending_league_ │
                                    │  joins           │
                                    └──────┬───────────┘
                                           │
                                           ▼
                                    ┌──────────────────┐
                                    │  Match Users     │
                                    │  (2 per match)   │
                                    └──────┬───────────┘
                                           │
                                           ▼
                                    ┌──────────────────┐
                                    │  Create Match    │
                                    │  Store in Redis  │
                                    └──────┬───────────┘
                                           │
                                           ▼
                                    ┌──────────────────┐
                                    │  Notify Players  │
                                    │  via Socket.IO   │
                                    └──────────────────┘

    ┌──────────────┐                    ┌──────────────┐
    │  Server      │                    │  Timer       │
    │  Startup     │──initializeCron()──▶│  Cron        │
    └──────────────┘                    │  (1s tick)   │
                                        └──────┬───────┘
                                               │
                                               ▼
                                    ┌──────────────────┐
                                    │  Get Active      │
                                    │  Games from      │
                                    │  Matchmaking     │
                                    └──────┬───────────┘
                                           │
                                           ▼
                                    ┌──────────────────┐
                                    │  For Each Game:  │
                                    │  • Fetch Match   │
                                    │  • Calculate     │
                                    │    Timers        │
                                    │  • Check Timeout │
                                    └──────┬───────────┘
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    │                                             │
                    ▼                                             ▼
        ┌──────────────────┐                        ┌──────────────────┐
        │  No Timeout      │                        │  Timeout         │
        │  • Update Redis  │                        │  • Declare       │
        │  • Emit Update   │                        │    Winner        │
        │    to Players    │                        │  • Update Wallet │
        └──────────────────┘                        │  • Cleanup       │
                                                     └──────────────────┘
```

### Cron Initialization Flow

```
┌─────────────────────────────────────────────────────────────────┐
│              CRON SERVICE INITIALIZATION                        │
└─────────────────────────────────────────────────────────────────┘

server.js
    │
    ├─> initializeCronService(io)
    │       │
    │       ├─> Check if already running
    │       │
    │       ├─> Set Socket.IO instance
    │       │   └─> Pass to timer modules
    │       │
    │       ├─> Get Cassandra session
    │       │
    │       ├─> For Each Game (Ludo, Snakes, TicTacToe, WaterSort):
    │       │       │
    │       │       ├─> Start Matchmaking Cron
    │       │       │   ├─> Create MatchmakingService instance
    │       │       │   ├─> Set interval (2000ms)
    │       │       │   └─> Call processMatchmaking() every 2s
    │       │       │
    │       │       └─> Start Timer Cron
    │       │           ├─> Get timer module
    │       │           ├─> Set interval (1000ms)
    │       │           └─> Call processTimers() every 1s
    │       │
    │       └─> Mark as running
    │
    └─> Cron jobs now active
```

### Key Features

1. **Independent Game Processing**
   - Each game has completely separate cron implementations
   - No shared code between games
   - Easy to modify one game without affecting others

2. **Error Handling**
   - Each cron job has try-catch blocks
   - Errors are logged but don't stop the cron
   - Cron continues running even if one cycle fails

3. **State Management**
   - Matchmaking service instances stored per game
   - Timer interval IDs tracked for cleanup
   - Running state tracked globally

4. **Cleanup on Shutdown**
   - SIGINT/SIGTERM handlers stop all crons
   - Clear all intervals
   - Close connections gracefully

### Timer Update Handler (Client-Initiated)

**Trigger**: When client sends `timer:updates` event

**Process**:
1. Extract user data from payload
2. Fetch match from Redis
3. Calculate timer values
4. Emit timer update to client
5. Set up interval for continuous updates (if action = 'start')
6. Clear interval when action = 'stop'

This is separate from the cron timer - it's for real-time client requests.

---

## 📡 Socket Events

### Connection Events

**`connection:established`** (Server → Client)
```javascript
{
  status: 'success',
  message: 'Connection established successfully!',
  socketId: 'socket-id',
  timestamp: '2024-01-01T00:00:00.000Z',
  serverInfo: {
    uptime: 12345,
    version: '1.0.0'
  }
}
```

### Ludo Events

**`check:opponent`** (Client → Server)
Checks if opponent has joined and initializes game pieces.

```javascript
{
  user_data: 'encrypted-user-data',
  jwt_token: 'jwt-token',
  game_id: 'game-uuid'
}
```

**`dice:roll`** (Client → Server)
```javascript
{
  user_data: 'encrypted-user-data',
  jwt_token: 'jwt-token',
  game_id: 'game-uuid',
  contest_id: 'contest-id'
}
```

**`piece:move`** (Client → Server)
```javascript
{
  user_data: 'encrypted-user-data',
  jwt_token: 'jwt-token',
  game_id: 'game-uuid',
  piece_id: 'piece-uuid',
  from_position: 'position',
  to_position: 'position'
}
```

**`quit:game`** (Client → Server)
```javascript
{
  user_data: 'encrypted-user-data',
  jwt_token: 'jwt-token',
  game_id: 'game-uuid',
  contest_id: 'contest-id'
}
```

**`timer:updates`** (Client → Server)
```javascript
{
  action: 'start' | 'stop',
  payload: {
    user_data: 'encrypted-user-data',
    jwt_token: 'jwt-token',
    game_id: 'game-uuid'
  }
}
```

**`timer:update`** (Server → Client)
```javascript
{
  game_id: 'game-uuid',
  status: 'active' | 'completed',
  user1_time: 15,
  user2_time: 15,
  user1_score: 0,
  user2_score: 0,
  user1_chance: 1,
  user2_chance: 1,
  turn: 'user1_id',
  elapsed_time_seconds: 250
}
```

### Snakes & Ladders Events

**`snakesladders_dice_roll`** (Client → Server)
**`snakesladders_piece_move`** (Client → Server)
**`snakesladders_quit_game`** (Client → Server)

### Tic-Tac-Toe Events

**`tictactoe_make_move`** (Client → Server)
**`tictactoe_quit_game`** (Client → Server)
**`tictactoe_timer_update`** (Server → Client)

### Water Sort Events

**`watersort_match_init`** (Client → Server)
**`watersort_shoot`** (Client → Server)
**`watersort_quit_game`** (Client → Server)

---

## 🗄️ Database Schema

### Cassandra Tables

#### `league_joins`
Stores league join information.

**Primary Key**: `(user_id, league_id, joined_at)`

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | text | User identifier |
| `league_id` | text | League identifier |
| `joined_at` | timestamp | Join timestamp |
| `status_id` | text | Status ('1' = pending, 'matched', etc.) |
| `entry_fee` | decimal | Entry fee amount |
| `prize_amount` | decimal | Prize amount |
| `extra_data` | text | JSON extra data |
| `opponent_user_id` | text | Matched opponent user ID |
| `opponent_league_id` | text | Opponent league ID |
| `match_pair_id` | uuid | Match pair ID |
| `turn_id` | text | Turn identifier |
| `join_month` | text | Month of join (YYYY-MM) |

#### `pending_league_joins`
Stores pending matchmaking requests (temporary table for matchmaking).

**Primary Key**: `(status_id, join_day, league_id, joined_at)`

| Column | Type | Description |
|--------|------|-------------|
| `status_id` | text | Status ('1' = pending) |
| `join_day` | text | Join day (YYYY-MM-DD) |
| `league_id` | text | League identifier |
| `joined_at` | timestamp | Join timestamp |
| `user_id` | text | User identifier |
| `id` | uuid | Join ID |
| `extra_data` | text | JSON extra data |
| `game_type` | text | Game type |
| `contest_type` | text | Contest type |
| `opponent_user_id` | text | Matched opponent (set when matched) |

#### `pending_league_joins_by_status`
Alternative view of pending joins indexed by status.

**Primary Key**: `(user_id, status_id, joined_at)`

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | text | User identifier |
| `status_id` | text | Status ('1' = pending) |
| `joined_at` | timestamp | Join timestamp |

#### `match_pairs`
Stores match pair information.

**Primary Key**: `id`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Match pair ID |
| `user1_id` | text | First user ID |
| `user2_id` | text | Second user ID |
| `user1_data` | text | User1 extra data (JSON) |
| `user2_data` | text | User2 extra data (JSON) |
| `status` | text | Match status |
| `created_at` | timestamp | Creation timestamp |
| `updated_at` | timestamp | Update timestamp |

#### `winner_declarations`
Stores winner declaration records.

**Primary Key**: `(game_id, win_month, user_id, declared_at)`

| Column | Type | Description |
|--------|------|-------------|
| `game_id` | text | Game identifier |
| `win_month` | text | Month of win (YYYY-MM) |
| `user_id` | text | Winner user ID |
| `declared_at` | timestamp | Declaration timestamp |
| `league_id` | text | League identifier |
| `contest_id` | text | Contest identifier |
| `prize_amount` | decimal | Prize amount |
| `score` | decimal | Score |
| `rank` | int | Winner rank |
| `win_loss_status` | text | Win/loss status |
| `extra_data` | text | JSON extra data |

#### `user_wallet`
Stores user wallet information.

**Primary Key**: `user_id`

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | text | User identifier |
| `balance` | decimal | Current balance |
| `credit` | decimal | Total credits |
| `debit` | decimal | Total debits |
| `win` | decimal | Total wins |
| `win_cr` | decimal | Win credits |

#### `transactions`
Stores transaction records.

**Primary Key**: `(user_id, transaction_id, transaction_time)`

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | text | User identifier |
| `transaction_id` | uuid | Transaction ID |
| `transaction_time` | timestamp | Transaction timestamp |
| `amount` | decimal | Transaction amount |
| `balance_after` | decimal | Balance after transaction |
| `transaction_type` | text | Transaction type |
| `metadata` | text | JSON metadata |

#### `sessions`
Stores user session information.

**Primary Key**: `user_id`

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | text | User identifier |
| `device_id` | text | Device identifier |
| `expires_at` | timestamp | Session expiration |
| `fcm_token` | text | FCM token |
| `is_active` | boolean | Active status |
| `jwt_token` | text | JWT token |
| `mobile_no` | text | Mobile number |
| `session_token` | text | Session token |
| `updated_at` | timestamp | Update timestamp |

#### `game_pieces`
Stores game piece information (for Ludo, Snakes & Ladders).

**Primary Key**: `(game_id, user_id, move_number)`

| Column | Type | Description |
|--------|------|-------------|
| `game_id` | text | Game identifier |
| `user_id` | text | User identifier |
| `move_number` | int | Move number |
| `piece_id` | uuid | Piece identifier |
| `player_id` | text | Player identifier (player1/player2) |
| `from_pos_last` | int | Last from position |
| `to_pos_last` | int | Last to position |
| `piece_type` | text | Piece type |
| `captured_piece` | text | Captured piece ID (if any) |
| `created_at` | timestamp | Creation timestamp |
| `updated_at` | timestamp | Update timestamp |

#### `dice_rolls_lookup`
Stores dice roll records for games.

**Primary Key**: `(game_id, user_id, created_at)`

| Column | Type | Description |
|--------|------|-------------|
| `game_id` | text | Game identifier |
| `user_id` | text | User identifier |
| `dice_id` | uuid | Dice roll identifier |
| `created_at` | timestamp | Roll timestamp |

#### `game_moves`
Stores all game moves for history and replay.

**Primary Key**: `(game_id, user_id, move_number)`

| Column | Type | Description |
|--------|------|-------------|
| `game_id` | text | Game identifier |
| `user_id` | text | User identifier |
| `game_type` | text | Game type |
| `move_type` | text | Move type |
| `move_number` | int | Move number |
| `move_data` | text | Move data (JSON) |
| `position_x` | int | X position |
| `position_y` | int | Y position |
| `position_index` | int | Position index |
| `target_position_x` | int | Target X position |
| `target_position_y` | int | Target Y position |
| `target_position_index` | int | Target position index |
| `value` | text | Move value |
| `score` | decimal | Score for this move |
| `move_time` | timestamp | Move timestamp |
| `updated_at` | timestamp | Update timestamp |

#### `levels`
Stores level data for Water Sort puzzle.

**Primary Key**: `level_no`

| Column | Type | Description |
|--------|------|-------------|
| `level_no` | int | Level number |
| `map_data` | text | Level map data (JSON) |

#### `users`
Stores user information.

**Primary Key**: `id`

| Column | Type | Description |
|--------|------|-------------|
| `id` | text | User identifier |
| `full_name` | text | User full name |
| `profile_data` | text | Profile data (JSON) |

---

## 🔑 Redis Keys & Data Structure

### Redis Key Patterns

```javascript
// Match Data
match:{gameId}                    // Ludo match data
snakesladders_match:{gameId}      // Snakes & Ladders match data
tictactoe_match:{gameId}          // Tic-Tac-Toe match data
watersort_match:{gameId}           // Water Sort match data

// User Chances
matchkey_userchance:{gameId}      // Ludo user chances
snakesladders_userchance:{gameId} // Snakes & Ladders user chances
tictactoe_userchance:{gameId}     // Tic-Tac-Toe user chances
watersort_userchance:{gameId}     // Water Sort user chances

// Socket Mappings
socket_to_user:{socketId}         // Socket ID to User ID mapping
user_to_socket:{userId}           // User ID to Socket ID mapping

// Session Data
session:{token}                   // Session data
user_session_lookup:{userId}      // User to session token mapping

// Winner Declaration Locks
winner_lock:{gameId}              // Distributed lock for winner declaration (TTL: 30s)
```

### Redis Lock Mechanism

The system uses Redis distributed locks for atomic operations:
- **Winner Declaration Lock**: `winner_lock:{gameId}` with 30-second TTL
- Prevents duplicate winner declarations in multi-instance deployments
- Uses Redis SETNX (SET if Not eXists) for atomic lock acquisition

### Match Data Structure (Example: Ludo)

```javascript
{
  game_id: 'uuid',
  user1_id: 'user-id',
  user2_id: 'user-id',
  status: 'active',
  turn: 'user1_id',
  user1_time: 15,
  user2_time: 15,
  user1_score: 0,
  user2_score: 0,
  contest_type: 'simple',
  league_id: 'league-id',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  // Game-specific data
  pieces: [...],
  dice_value: 0,
  // ... other game state
}
```

### User Chances Structure

```javascript
{
  'user1_id': 3,
  'user2_id': 3
}
```

### Redis TTL

- **Match Data**: 24 hours (`REDIS_TTL.MATCH_SECONDS`)
- **Session Data**: 1 hour (`REDIS_TTL.SESSION_SECONDS`)
- **Cache Data**: 5 minutes (`REDIS_TTL.CACHE_SECONDS`)

---

## ⚠️ Error Handling

### Error Structure

```javascript
{
  status: 'error',
  error_code: 'error_code',
  error_type: 'validation' | 'authentication' | 'database' | 'system',
  field: 'field_name',  // Optional
  message: 'Error message',
  event: 'event_name'   // Socket event name
}
```

### Error Types

- **`validation`**: Field validation errors
- **`authentication`**: Authentication failures
- **`database`**: Database errors
- **`system`**: System errors
- **`decryption`**: Decryption errors

### Error Handler Utilities

**`src/utils/errorHandler.js`**:
- `safeExecute()`: Safe async execution with error handling
- `safeExecuteAll()`: Parallel safe execution
- `emitStandardError()`: Emit standard error format

**`src/utils/emitError.js`**:
- `emitError()`: Emits standardized error response to client
- Supports custom error codes, types, fields, and messages

**`src/utils/validateFields.js`**:
- `validateFields()`: Validates required fields in data object
- Emits errors for each missing field
- Returns boolean indicating validation success

---

## 🔐 Security

### Authentication

- **JWT-based authentication** for all socket connections
- **Token validation** on every request
- **Single connection per user** (old socket disconnected on new connection)
- **User session management** with Redis

### Data Encryption

- **User data encryption** using JWT
- **Sensitive data** stored encrypted in database
- **Secure token transmission**

### Best Practices

- Input validation on all handlers
- Parameterized queries (CQL prepared statements)
- XSS prevention
- CORS configuration
- Rate limiting (recommended for production)

---

## 🚢 Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure Redis cluster
- [ ] Configure Cassandra cluster
- [ ] Set up monitoring
- [ ] Configure logging
- [ ] Set up backup
- [ ] Configure SSL/TLS
- [ ] Set up load balancing
- [ ] Configure Redis username/password (if using ACL)

### Docker Deployment

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### PM2 Deployment

```bash
pm2 start src/server.js --name socket-game-server
pm2 save
pm2 startup
```

---

## 🔧 Troubleshooting

### Common Issues

#### 1. Redis Connection Error
**Problem**: Cannot connect to Redis

**Solutions**:
- Check Redis is running: `redis-cli ping` (should return `PONG`)
- Verify `REDIS_URL`, `REDIS_USERNAME`, `REDIS_PASSWORD` in `.env`
- Check firewall settings
- Verify Redis ACL configuration (if using username)

#### 2. Cassandra Connection Error
**Problem**: Cannot connect to Cassandra

**Solutions**:
- Check Cassandra is running
- Verify `CASSANDRA_HOST`, `CASSANDRA_PORT` in `.env`
- Ensure keyspace exists
- Check network connectivity
- Verify credentials

#### 3. JWT Authentication Failed
**Problem**: Authentication errors

**Solutions**:
- Verify `JWT_SECRET` is set in `.env`
- Check token expiration time
- Ensure token is properly formatted
- Verify token signing algorithm matches

#### 4. Game Not Starting
**Problem**: Match not found

**Solutions**:
- Check matchmaking cron is running
- Verify cron service initialized
- Check `league_joins` table has entries
- Verify Redis connection
- Check match creation in `match_pairs` table

#### 5. Timer Not Updating
**Problem**: Timer events not firing

**Solutions**:
- Check timer handler registered
- Verify timer cron is running
- Check Redis match data exists
- Verify Socket.IO connection is active
- Check timer interval is set correctly

#### 6. Winner Not Declared
**Problem**: Winner declaration not working

**Solutions**:
- Check timer cron is running
- Verify `windeclearService` is called
- Check database connection
- Verify wallet service is working
- Check error logs for winner declaration errors

---

## 🛠️ Utility Functions

### Timer Utilities (`src/utils/timer.js`)

**TimerRegistry Class**:
- Tracks active timers for each game
- Manages timer lifecycle (register, unregister, cleanup)
- Prevents duplicate timer registrations
- EventEmitter-based for timer events

**Functions**:
- `calculateGameCountdown()`: Calculates remaining game time
- Timer registry management methods

### Timer Payload Creators (`src/utils/timerPayloads.js`)

Creates standardized timer update payloads for all games:
- `createLudoTimerUpdatePayload()`: Ludo timer payload
- `createSnakesLaddersTimerUpdatePayload()`: Snakes & Ladders timer payload
- `createTicTacToeTimerUpdatePayload()`: Tic-Tac-Toe timer payload
- `createWaterSortTimerUpdatePayload()`: Water Sort timer payload

Ensures consistent format between handlers and cron jobs.

### Parallel Processing Utilities (`src/utils/parallelUtils.js`)

**Functions**:
- `processInParallel()`: Process items in parallel with concurrency limit
- Prevents overwhelming the system with too many concurrent operations
- Default concurrency: 5 operations

### Data Utilities (`src/utils/dataUtils.js`)

Utility functions for data transformation:
- `toDate()`: Convert to Date object
- `safeJSONParse()`: Safe JSON parsing
- `toFloat()`: Convert to float
- `getRowValue()`: Extract row value
- `normalizeUuid()`: Normalize UUID format
- `sanitizeLeagueIds()`: Sanitize league IDs
- `resolveOpponentLeagueId()`: Resolve opponent league ID
- `toInterfaceSlice()`: Convert to interface slice

### Date Utilities (`src/utils/dateUtils.js`)

Date manipulation functions:
- `toISOString()`: Convert to ISO string
- Date formatting utilities

### Match Utilities (`src/utils/matchUtils.js`)

Match-related utility functions for game state management.

### User Utilities (`src/utils/userUtils.js`)

User-related utility functions.

### Game Utilities (`src/utils/gameUtils.js`)

Game-specific utility functions.

### Cassandra Service (`src/utils/cassandraService.js`)

Cassandra database service utilities and helpers.

### Constants Utility Functions

From `src/constants/index.js`:
- `getContestTypeMaxChances(contestType)`: Get max chances for contest type
- `getTodayString(date)`: Get current date string (YYYY-MM-DD)
- `getCurrentMonth(date)`: Get current month string (YYYY-MM)

### Database Query Constants

All database queries are defined in `src/constants/index.js` under `DB_QUERIES`:
- `SELECT_PENDING`: Query pending league joins
- `INSERT_MATCH_PAIR`: Insert match pair
- `INSERT_DICE_LOOKUP`: Insert dice roll record
- `UPDATE_PENDING_OPPONENT`: Update pending opponent
- `DELETE_PENDING`: Delete pending join
- `DELETE_PENDING_BY_STATUS`: Delete pending by status
- `UPDATE_LEAGUE_JOIN`: Update league join
- `UPDATE_LEAGUE_EXPIRED`: Update expired league join
- `SELECT_LEAGUE_JOIN_EXTRA`: Select league join extra data
- `SELECT_USER_DETAILS`: Select user details
- `SELECT_LEVEL_MAP`: Select level map data
- `INSERT_GAME_MOVE`: Insert game move record

---

## 📝 Summary

This application is a **real-time multiplayer game server** that:

1. **Accepts WebSocket connections** from clients
2. **Authenticates users** using JWT tokens
3. **Matches players** automatically via cron jobs
4. **Manages game state** in Redis for fast access
5. **Processes game actions** in real-time
6. **Monitors timers** and declares winners
7. **Handles disconnections** gracefully
8. **Distributes prizes** to winners
9. **Stores game history** in Cassandra

The system is designed to be **scalable**, **reliable**, and **maintainable** with clear separation of concerns and modular architecture.

---

**Last Updated**: 2024
**Version**: 1.0.0
**Maintained By**: Development Team

---------------------------------------------------------------------

Use this separation pattern:

- API/socket server only
- Cron worker only

You already have scripts for this in `package.json`:

```bash
npm run start:server   # starts src/server.js with --no-cron
npm run start:cron     # starts src/cron-worker.js
```

How it works:
1. `src/server.js` runs HTTP + Socket.IO.
2. `src/cron-worker.js` runs scheduled matchmaking/timers.
3. `--no-cron` prevents cron from starting inside server process.
