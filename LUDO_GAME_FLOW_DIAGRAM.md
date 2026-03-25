# Ludo Game Complete Flow Diagram - All Aspects Covered

```mermaid
flowchart TB
    Start([Game Start]) --> Matchmaking[Matchmaking Service<br/>Cron Job Every 2s]
    
    %% ============================================================================
    %% MATCHMAKING FLOW - Complete Details
    %% ============================================================================
    Matchmaking --> LoadPending[Load Pending Users<br/>FROM pending_league_joins<br/>WHERE status_id='1'<br/>AND join_day IN today,yesterday<br/>AND league_id IN leagues<br/>AND server_id]
    LoadPending --> CheckExpiry{User Expired?<br/>joined_at < now - 10s}
    CheckExpiry -->|Yes| ExpireUser[Expire User Process]
    ExpireUser --> GetEntryFee[Get Entry Fee<br/>FROM league_joins<br/>entry_fee or extra_data]
    GetEntryFee --> ProcessRefund[Process Refund<br/>Credit Wallet<br/>Record Transaction<br/>DELETE pending entries<br/>UPDATE league_joins status='expired']
    CheckExpiry -->|No| CheckPair{Can Pair Users?<br/>- Same league_id<br/>- Same game_type='ludo'<br/>- Same contest_type<br/>- Different user_id}
    CheckPair -->|No| WaitForOpponent[Wait for Opponent<br/>Check Bot Integration]
    WaitForOpponent --> CheckExpiryWarning{In Expiry Window?<br/>10s-6s before expiry}
    CheckExpiryWarning -->|Yes| TriggerBot[Trigger Bot Start API<br/>POST /api/bot/start<br/>with bot user data]
    CheckPair -->|Yes| CreateMatch[Create Match Pair]
    
    CreateMatch --> CreateMatchPairDB[INSERT INTO match_pairs<br/>id=TimeUuid<br/>user1_id, user2_id<br/>status='active'<br/>created_at, updated_at]
    CreateMatchPairDB --> CreatePieces[Create Game Pieces<br/>GamePiecesService.createPiecesForMatch<br/>4 pieces per user<br/>INSERT INTO game_pieces<br/>position='initial' or '1'<br/>based on contest_type]
    CreatePieces --> CreateDice[Create Dice Lookup<br/>INSERT INTO dice_rolls_lookup<br/>game_id, user_id, dice_id=UUID<br/>for both users]
    CreateDice --> UpdateLeagueJoins[Update League Joins<br/>UPDATE league_joins<br/>SET opponent_user_id<br/>opponent_league_id<br/>match_pair_id<br/>turn_id 1 or 2<br/>status='matched']
    UpdateLeagueJoins --> UpdateLeagueJoinsById[UPDATE league_joins_by_id<br/>Fast lookup table<br/>Same fields as above]
    UpdateLeagueJoinsById --> DeletePending[DELETE FROM pending_league_joins<br/>DELETE FROM pending_league_joins_by_status<br/>for both users]
    DeletePending --> StoreRedis[Store Match in Redis<br/>SET match:gameId<br/>TTL=24 hours<br/>Contains:<br/>- user1_pieces, user2_pieces<br/>- user1_dice, user2_dice<br/>- user1_time, user2_time<br/>- turn, status='active'<br/>- user1_chance=3, user2_chance=3<br/>- contest_type, game_type<br/>- scores, turnCount]
    StoreRedis --> StoreUserChance[Store User Chances<br/>SET matchkey_userchance:gameId<br/>user1_id: 3<br/>user2_id: 3]
    StoreUserChance --> EnsureSessions[Ensure User Sessions<br/>Check sessions table<br/>Store in Redis<br/>session:token]
    EnsureSessions --> GameReady([Game Ready])
    
    %% ============================================================================
    %% SOCKET CONNECTION & HANDLER REGISTRATION
    %% ============================================================================
    GameReady --> SocketConnect[Socket Connection<br/>io.on connection]
    SocketConnect --> AuthMiddleware[Authentication Middleware<br/>withAuth middleware<br/>JWT validation<br/>Session validation]
    AuthMiddleware --> RegisterHandlers[Register All Handlers]
    
    RegisterHandlers --> Handler1[check:opponent Handler]
    RegisterHandlers --> Handler2[dice:roll Handler]
    RegisterHandlers --> Handler3[piece:move Handler]
    RegisterHandlers --> Handler4[quit:game Handler]
    RegisterHandlers --> Handler5[timer_updates Handler]
    RegisterHandlers --> Handler6[disconnect Handler]
    
    %% ============================================================================
    %% CHECK OPPONENT FLOW - Complete Details
    %% ============================================================================
    Handler1 --> CheckOpponent[check:opponent Event]
    CheckOpponent --> DecryptData[Decrypt User Data<br/>decryptUserData<br/>user_data + jwt_token]
    DecryptData --> ValidateJWT{JWT Valid?<br/>validateJWTToken<br/>validateJwtClaims}
    ValidateJWT -->|No| EmitError1[Emit Error<br/>opponent:response<br/>code: invalid_token]
    ValidateJWT -->|Yes| ValidateSession1{Session Valid?<br/>sessionService.getSession<br/>is_active=true}
    ValidateSession1 -->|No| EmitError2[Emit Error<br/>session_not_found]
    ValidateSession1 -->|Yes| ValidateFields1{Required Fields?<br/>user_id, contest_id, l_id}
    ValidateFields1 -->|No| EmitError3[Emit Error]
    ValidateFields1 -->|Yes| GetLeagueJoin[Get League Join Entry<br/>SELECT FROM league_joins_by_id<br/>WHERE id=l_id<br/>OR FROM league_joins<br/>WHERE user_id, status_id, join_month]
    GetLeagueJoin --> HasOpponent{Has Opponent?<br/>opponent_user_id exists<br/>AND != user_id}
    HasOpponent -->|No| CheckCompleted{Game Completed?<br/>SELECT FROM league_joins<br/>status='completed'}
    CheckCompleted -->|Yes| EmitCompleted[Emit Completed Status<br/>opponent:response<br/>status='completed']
    CheckCompleted -->|No| EmitPending[Emit Pending Status<br/>opponent:response<br/>status='pending'<br/>message='Waiting for opponent']
    HasOpponent -->|Yes| CheckMatchStatus{Match Status?<br/>SELECT FROM match_pairs<br/>WHERE id=match_pair_id<br/>status='completed'?}
    CheckMatchStatus -->|Yes| EmitCompleted
    CheckMatchStatus -->|No| FetchPieces[Fetch Game Pieces & Dice<br/>FROM Redis match:gameId<br/>OR FROM game_pieces table<br/>user1_pieces, user2_pieces<br/>user1_dice, user2_dice]
    FetchPieces --> EnhancePieces[Enhance Pieces Data<br/>Add comprehensive metadata<br/>piece_id, from_pos_last<br/>to_pos_last, piece_type]
    EnhancePieces --> GetUserProfiles[Get User Profiles<br/>SELECT FROM users<br/>full_name, profile_data<br/>for user and opponent]
    GetUserProfiles --> EmitOpponentData[Emit Opponent Data<br/>opponent:response<br/>status='success'<br/>user_pieces, opponent_pieces<br/>user_dice, opponent_dice<br/>user_full_name, opponent_full_name<br/>game_id, turn_id]
    
    %% ============================================================================
    %% DICE ROLL FLOW - Complete Details
    %% ============================================================================
    Handler2 --> DiceRoll[dice:roll Event]
    DiceRoll --> DecryptData2[Decrypt User Data]
    DecryptData2 --> ValidateAuth1{Authenticated?<br/>withAuth middleware}
    ValidateAuth1 -->|No| EmitError4[Emit Error]
    ValidateAuth1 -->|Yes| ValidateFields2{Fields Valid?<br/>game_id, contest_id<br/>session_token, device_id<br/>jwt_token, user_id}
    ValidateFields2 -->|No| EmitError5[Emit Error<br/>invalid_value]
    ValidateFields2 -->|Yes| FetchMatch1[Fetch Match from Redis<br/>GET match:gameId<br/>Parse JSON]
    FetchMatch1 --> CheckGameStatus1{Game Completed?<br/>status='completed'<br/>OR winner exists}
    CheckGameStatus1 -->|Yes| EmitError6[Emit Error<br/>game_already_completed]
    CheckGameStatus1 -->|No| ValidateUser1{User in Match?<br/>user_id == user1_id<br/>OR user2_id}
    ValidateUser1 -->|No| EmitError7[Emit Error<br/>invalid_user]
    ValidateUser1 -->|Yes| ValidateTurn1{User's Turn?<br/>match.turn == user_id}
    ValidateTurn1 -->|No| EmitError8[Emit Error<br/>turn_expired]
    ValidateTurn1 -->|Yes| CheckTimer1{Timer Valid?<br/>user1_time or user2_time<br/>greater than 0<br/>Calculate remaining time}
    CheckTimer1 -->|No| EmitError9[Emit Error<br/>timer_expired]
    CheckTimer1 -->|Yes| CheckTimeout{Turn Timeout?<br/>last_move_time > 15s ago<br/>ALLOWED_TURN_DELAY_SECONDS}
    CheckTimeout -->|Yes| ForfeitTurn[Forfeit Turn<br/>Update match.turn = opponent<br/>Update timestamps<br/>SAVE to Redis]
    CheckTimeout -->|No| ProcessDiceRoll[Process Dice Roll]
    
    ProcessDiceRoll --> ValidateSession2{Session Valid?<br/>sessionService.getSession<br/>device_id match<br/>is_active=true}
    ValidateSession2 -->|No| EmitError10[Emit Error]
    ValidateSession2 -->|Yes| GetRollCounters[Get Roll Counters<br/>total_rolls_user1/user2<br/>last_six_get_user1/user2<br/>consecutive_six_user1/user2<br/>from match state]
    GetRollCounters --> CheckGuaranteedSix{In Guaranteed Mode?<br/>in_guaranteed_six_mode<br/>AND total_rolls >= 5<br/>AND first_six not rolled}
    CheckGuaranteedSix -->|Yes| GenerateGuaranteedTurns[Generate Guaranteed Turns<br/>3 random turns from 6-10<br/>Store in guaranteed_six_turns<br/>Set in_guaranteed_six_mode=true<br/>guaranteed_six_turns_remaining=3]
    CheckGuaranteedSix -->|No| RollDice[Roll Dice with Logic]
    GenerateGuaranteedTurns --> RollDice
    
    RollDice --> CheckGuaranteedTurn{Is Guaranteed Turn?<br/>total_rolls in<br/>guaranteed_six_turns array}
    CheckGuaranteedTurn -->|Yes| ForceSix[Force Dice = 6<br/>isGuaranteedSix=true]
    CheckGuaranteedTurn -->|No| GenerateRandom[Generate Random 1-6<br/>Math.random]
    ForceSix --> CheckFirstSix{First Six?<br/>last_six_get == 0<br/>AND rolled 6}
    GenerateRandom --> CheckFirstSix
    
    CheckFirstSix -->|Yes| SetFirstSix[Set first_six_rolled=true<br/>isFirstSix=true<br/>last_six_get=total_rolls]
    CheckFirstSix -->|No| CheckConsecutive{Consecutive Six?<br/>previous roll was 6}
    SetFirstSix --> CheckConsecutive
    
    CheckConsecutive -->|Yes| IncrementConsecutive[Increment consecutive_six<br/>consecutive_sixes++]
    CheckConsecutive -->|No| ResetConsecutive[Reset consecutive_six=0]
    IncrementConsecutive --> CheckThreeSixes{3 Consecutive Sixes?<br/>consecutive_sixes >= 3}
    ResetConsecutive --> CheckThreeSixes
    
    CheckThreeSixes -->|Yes| LoseTurn[Lose Turn<br/>special_rule='three_consecutive_sixes'<br/>turn_passed=true<br/>can_move_pieces=false<br/>gets_another_turn=false<br/>Reset consecutive_six=0]
    CheckThreeSixes -->|No| PersistDice[Persist Dice Roll]
    LoseTurn --> PersistDice
    
    PersistDice --> GetDiceLookup[Get/Create Dice Lookup ID<br/>SELECT FROM dice_rolls_lookup<br/>OR INSERT new UUID]
    GetDiceLookup --> InsertDiceRoll[INSERT INTO dice_rolls_data<br/>lookup_dice_id, roll_id=UUID<br/>dice_number, roll_timestamp<br/>session_token, device_id<br/>contest_id, created_at]
    InsertDiceRoll --> UpdateMatchCounters[Update Match Counters<br/>total_rolls++<br/>last_six_get if 6<br/>consecutive_six<br/>SAVE to Redis]
    UpdateMatchCounters --> CheckPieceState[Check Piece Movement State<br/>Get user pieces<br/>Analyze piece states]
    
    CheckPieceState --> AnalyzePieces[Analyze Pieces:<br/>- piecesAtHome count<br/>- piecesNotAtHome count<br/>- piecesAtGoal count<br/>- piecesCanMove count<br/>- piecesStuck count]
    AnalyzePieces --> AllAtHome{All Pieces at Home?<br/>all pieces at 'initial'}
    AllAtHome -->|Yes| NeedsSix{Needs 6 to Start?<br/>first_six not rolled}
    NeedsSix -->|Yes & Rolled 6| ExtraTurn1[Get Extra Turn<br/>gets_another_turn=true<br/>turn stays same]
    NeedsSix -->|Yes & Not 6| PassTurn1[Pass Turn<br/>turn = opponent<br/>turn_passed=true]
    NeedsSix -->|No| CheckCanMove{Can Move Any Piece?<br/>Check each piece:<br/>from_pos + dice <= 57}
    
    AllAtHome -->|No| CheckCanMove
    CheckCanMove -->|No| CheckSixRolled{Rolled 6?}
    CheckSixRolled -->|Yes| ExtraTurnNoMove[Extra Turn Granted<br/>No legal move available<br/>gets_another_turn=true<br/>can_move_pieces=false]
    CheckSixRolled -->|No| PassTurn2[Pass Turn]
    CheckCanMove -->|Yes| CheckSix{Rolled 6?}
    CheckSix -->|Yes| CheckConsecutive2{3 Consecutive Sixes?}
    CheckConsecutive2 -->|Yes| LoseTurn2[Lose Turn]
    CheckConsecutive2 -->|No| ExtraTurn2[Get Extra Turn]
    CheckSix -->|No| CheckAllNeedLess{All Pieces Need<br/>Less Than 6?<br/>distance to home < 6<br/>for all movable pieces}
    CheckAllNeedLess -->|Yes| ResetTimer[Reset Timer & Roll Again<br/>user1_time = now<br/>user2_time = now<br/>turn stays same<br/>last_rolled_dice = null<br/>gets_another_turn=true<br/>can_move_pieces=false]
    CheckAllNeedLess -->|No| NormalTurn[Continue Turn<br/>can_move_pieces=true]
    
    ExtraTurn1 --> ScoreDiceRoll[Score Dice Roll]
    ExtraTurn2 --> ScoreDiceRoll
    NormalTurn --> ScoreDiceRoll
    ResetTimer --> ScoreDiceRoll
    PassTurn1 --> ScoreDiceRoll
    PassTurn2 --> ScoreDiceRoll
    LoseTurn2 --> ScoreDiceRoll
    ExtraTurnNoMove --> ScoreDiceRoll
    
    ScoreDiceRoll --> CalculateScore[Calculate Score:<br/>Base = dice_number<br/>+ 10 if six<br/>+ 5 if first six<br/>+ 2 per consecutive six<br/>+ 25 if rolled 1 lucky]
    CalculateScore --> UpdateMatchScore[Update Match Score<br/>user1_score or user2_score += points<br/>scores object with user_id key += points<br/>SAVE to Redis]
    UpdateMatchScore --> UpdateTurn[Update Turn & Timestamps<br/>match.turn<br/>match.user1_time = now<br/>match.user2_time = now<br/>match.turnCount object with user_id key++<br/>match.previousTurn = user_id]
    UpdateTurn --> SaveMatch1[Save Match State to Redis<br/>SET match:gameId<br/>with all updated fields]
    SaveMatch1 --> NotifyPlayers1[Notify Both Players]
    NotifyPlayers1 --> EmitToUser[socket.emit<br/>dice:roll:response<br/>dice_number, is_six<br/>gets_another_turn<br/>can_move_pieces<br/>turn, score_earned<br/>dice_six_tracking]
    EmitToUser --> BroadcastOpponent[broadcastDiceRollToOpponent<br/>io.to opponentSocketId<br/>opponent:dice:roll:update]
    
    %% ============================================================================
    %% PIECE MOVE FLOW - Complete Details
    %% ============================================================================
    Handler3 --> PieceMove[piece:move Event]
    PieceMove --> DecryptData3[Decrypt User Data]
    DecryptData3 --> ValidateAuth2{Authenticated?}
    ValidateAuth2 -->|No| EmitError11[Emit Error]
    ValidateAuth2 -->|Yes| ValidatePayload{Payload Valid?<br/>game_id, user_id<br/>piece_id, from_pos_last<br/>to_pos_last, piece_type<br/>dice_number 1-6}
    ValidatePayload -->|No| EmitError12[Emit Error<br/>invalid_value]
    ValidatePayload -->|Yes| ValidatePositions{Positions Valid?<br/>from_pos: 0-57 or 'initial'<br/>to_pos: 0-57 or 'initial'/'goal'}
    ValidatePositions -->|No| EmitError13[Emit Error]
    ValidatePositions -->|Yes| FetchMatch2[Fetch Match from Redis]
    FetchMatch2 --> CheckGameStatus2{Game Completed?}
    CheckGameStatus2 -->|Yes| EmitError14[Emit Error]
    CheckGameStatus2 -->|No| ValidateTurn2{User's Turn?}
    ValidateTurn2 -->|No| EmitError15[Emit Error<br/>turn_expired]
    ValidateTurn2 -->|Yes| ValidateFirstSix{First Six Rolled?<br/>first_six_rolled_user1/user2<br/>if moving from 'initial'}
    ValidateFirstSix -->|No| EmitError16[Emit Error<br/>first_six_required]
    ValidateFirstSix -->|Yes| CheckOvershoot{Overshoot Home?<br/>to_pos > 57<br/>OR from_pos + dice > 57}
    CheckOvershoot -->|Yes| EmitError17[Emit Error<br/>illegal_move<br/>Need exactly X to reach home]
    CheckOvershoot -->|No| EvaluateMove[Evaluate Move Against Board]
    
    EvaluateMove --> LoadPieces[Load Pieces from Redis<br/>user1_pieces, user2_pieces<br/>OR FROM game_pieces table]
    LoadPieces --> CheckBoardState[Check Board State:<br/>- Own pieces on to_pos<br/>- Opponent pieces on to_pos<br/>- Safe squares check<br/>Safe squares: 1,9,14,22,27,35,40,48]
    CheckBoardState --> CheckOwnBlock{Own Block?<br/>2+ own pieces on to_pos}
    CheckOwnBlock -->|Yes| EmitError18[Emit Error<br/>Cannot move - own block]
    CheckOwnBlock -->|No| CheckOpponentBlock{Opponent Block?<br/>2+ opponent pieces on to_pos}
    CheckOpponentBlock -->|Yes| EmitError19[Emit Error<br/>Cannot move - opponent block]
    CheckOpponentBlock -->|No| CheckSafeSquare{On Safe Square?<br/>to_pos in safe squares}
    CheckSafeSquare -->|Yes| SafeMove[Safe Move<br/>No kill possible]
    CheckSafeSquare -->|No| CheckKill{Kill Detected?<br/>evaluateKillByMapping<br/>Check kill position mapping<br/>52 kill positions<br/>user_pos maps to opponent_pos}
    
    CheckKill -->|Yes| PerformKill[Perform Kill Service]
    PerformKill --> GetKilledPieces[Get Killed Pieces<br/>Find opponent pieces<br/>on target kill position]
    GetKilledPieces --> UpdateKilledPiece[Update Killed Piece<br/>Reset to_pos_last<br/>'initial' for simple<br/>'1' for quick/classic<br/>Update in Redis match]
    UpdateKilledPiece --> InsertKillAudit[INSERT INTO piece_kills<br/>game_id, piece_id<br/>user_id, killed_user_id<br/>killed_at, created_at]
    InsertKillAudit --> UpdateKillScore[Update Kill Score<br/>+10 points for kill<br/>Update match scores]
    CheckKill -->|No| ProcessMove[Process Piece Move]
    
    ProcessMove --> UpdatePieceDB[UPDATE game_pieces<br/>SET from_pos_last<br/>to_pos_last<br/>piece_type<br/>captured_piece<br/>updated_at<br/>WHERE game_id, user_id<br/>piece_id, move_number=0]
    UpdatePieceDB --> InsertPieceMove[INSERT INTO piece_moves<br/>game_id, user_id, piece_id<br/>last_position=to_pos<br/>total_moves=1<br/>created_at, updated_at]
    InsertPieceMove --> UpdatePieceRedis[Update Piece in Redis Match<br/>Find piece in user1_pieces/user2_pieces<br/>Update from_pos_last, to_pos_last<br/>piece_type, updated_at<br/>SAVE to Redis]
    UpdatePieceRedis --> CheckHomeReach{Exact Home Reach?<br/>to_pos == 57<br/>AND from_pos < 57}
    
    CheckHomeReach -->|Yes| GrantExtraTurn[Grant Home Reach Extra Turn<br/>match.turn = user_id<br/>Update timestamps<br/>Home reach bonus +15 points]
    CheckHomeReach -->|No| CheckKill2{Kill Occurred?}
    CheckKill2 -->|Yes| KeepTurn[Keep Turn<br/>match.turn = user_id<br/>Kill bonus +10 points]
    CheckKill2 -->|No| CheckDiceSix{Rolled 6?}
    CheckDiceSix -->|Yes| ExtraTurn3[Get Extra Turn<br/>match.turn = user_id]
    CheckDiceSix -->|No| PassTurn3[Pass Turn to Opponent<br/>match.turn = opponent_id]
    
    GrantExtraTurn --> ScoreMove[Score Piece Move]
    KeepTurn --> ScoreMove
    ExtraTurn3 --> ScoreMove
    PassTurn3 --> ScoreMove
    
    ScoreMove --> CalculateMoveScore[Calculate Move Score:<br/>+10 if kill<br/>+15 if home reach<br/>+2 if safe square<br/>+5 if perfect home move]
    CalculateMoveScore --> UpdateMoveScore[Update Match Score<br/>user1_score or user2_score<br/>scores object with user_id key<br/>SAVE to Redis]
    UpdateMoveScore --> CheckWin{All Pieces Home?<br/>All 4 pieces<br/>to_pos_last == 'goal'<br/>OR 'finished'}
    CheckWin -->|Yes| DeclareWinner[Declare Winner]
    CheckWin -->|No| UpdateMatch2[Update Match State<br/>Update turnCount<br/>Update previousTurn<br/>SAVE to Redis]
    
    DeclareWinner --> ProcessWinner[Process Winner Declaration]
    ProcessWinner --> GetLeagueInfo[Get League Join Info<br/>SELECT FROM league_joins<br/>entry_fee, league_id<br/>for winner and loser]
    GetLeagueInfo --> CalculatePrize[Calculate Prize Amount<br/>prize = entry_fee * 2<br/>for winner only]
    CalculatePrize --> InsertWinnerDecl[INSERT INTO winner_declarations<br/>game_id, user_id<br/>league_id, contest_id<br/>status='WIN'/'LOSS'<br/>prize_amount<br/>user_score, user1_score<br/>user2_score, game_end_reason<br/>created_at]
    InsertWinnerDecl --> UpdateMatchPair[UPDATE match_pairs<br/>SET status='completed'<br/>winner=winner_id<br/>updated_at]
    UpdateMatchPair --> CreditWallet[Credit Winner Wallet<br/>UPDATE user_wallet<br/>SET balance += prize<br/>credit += prize<br/>last_updated]
    CreditWallet --> RecordTransaction[INSERT INTO user_wallet_history<br/>user_id, type='credit'<br/>amount=prize<br/>balance_after<br/>metadata, details<br/>txn_month, txn_time, txn_id]
    RecordTransaction --> UpdateLeagueStatus[UPDATE league_joins<br/>SET status='completed'<br/>for both users]
    UpdateLeagueStatus --> UpdateLeagueStatusById[UPDATE league_joins_by_id<br/>SET status='completed'<br/>for both users]
    UpdateLeagueStatusById --> CleanupRedis[Cleanup Redis Match Data<br/>DEL match:gameId<br/>DEL matchkey_userchance:gameId<br/>DEL ludo_winner_declared:gameId<br/>SREM ludo_active_games gameId]
    CleanupRedis --> StopTimers[Stop All Timers<br/>timerRegistry.unregisterTimer<br/>timerEventBus.emitTimerStop<br/>Emit stop:timer_updates<br/>to all sockets]
    StopTimers --> ClearSessions[Clear User Sessions<br/>sessionService.clearSessionsForMatch<br/>DEL session:token<br/>for both users]
    ClearSessions --> EmitGameWon[Emit game:won Event<br/>to winner socket<br/>status='success'<br/>winner_id, completed_at]
    EmitGameWon --> EmitGameLost[Emit game:lost Event<br/>to loser socket<br/>status='info'<br/>winner_id, loser_id]
    
    UpdateMatch2 --> SaveMatch2[Save Match State<br/>SAVE to Redis]
    SaveMatch2 --> NotifyPlayers2[Notify Both Players]
    NotifyPlayers2 --> EmitToUser2[socket.emit<br/>piece:move:response<br/>piece_id, from_pos, to_pos<br/>kill_details if kill<br/>score_earned<br/>turn, user1_pieces<br/>user2_pieces]
    EmitToUser2 --> BroadcastOpponent2[broadcastPieceMoveToOpponent<br/>io.to opponentSocketId<br/>opponent:move:update]
    
    %% ============================================================================
    %% TIMER MANAGEMENT FLOW - Complete Details
    %% ============================================================================
    Handler5 --> TimerStart[start:timer_updates Event]
    TimerStart --> ExtractUserData[Extract User Data<br/>from user_data or direct<br/>game_id, user_id]
    ExtractUserData --> ValidateFields3{Fields Valid?}
    ValidateFields3 -->|No| EmitError20[Emit Error]
    ValidateFields3 -->|Yes| FetchMatch3[Fetch Match from Redis]
    FetchMatch3 --> CheckGameStatus3{Game Completed?}
    CheckGameStatus3 -->|Yes| EmitError21[Emit Error<br/>game_already_completed]
    CheckGameStatus3 -->|No| GetUserRole[Get User Role<br/>isUser1 or isUser2<br/>timeKey, connectionCountKey]
    GetUserRole --> UpdateConnection[Update Connection Count<br/>If connection_count equals 0<br/>Set timeKey = now<br/>connection_count = 1<br/>start_time = now if not set]
    UpdateConnection --> AddToActiveGames[SADD ludo_active_games gameId<br/>Add to active games set]
    AddToActiveGames --> EmitTimerStart[timerEventBus.emitTimerStart<br/>'ludo', gameId, socketId, userId]
    EmitTimerStart --> CalculateTime[Calculate Remaining Time<br/>user1_time_remaining<br/>user2_time_remaining<br/>MAX_TIMER_SECONDS - elapsed]
    CalculateTime --> GetUserChances[Get User Chances<br/>GET matchkey_userchance:gameId<br/>user1_chance, user2_chance]
    GetUserChances --> ExtractScores[Extract Scores<br/>user1_score, user2_score<br/>from match.scores or direct]
    ExtractScores --> GetGameStats[Get Game Statistics<br/>user1_pieces_home/out/finished<br/>user2_pieces_home/out/finished<br/>total_turns, game_duration]
    GetGameStats --> CreateTimerPayload[Create Timer Payload<br/>createLudoTimerUpdatePayload<br/>All timer data combined]
    CreateTimerPayload --> EmitTimerUpdate[Emit timer_update<br/>to socket<br/>All game state data]
    EmitTimerUpdate --> EmitTimerStarted[Emit timer_started<br/>status='success'<br/>match_start_time<br/>elapsed_time_seconds]
    EmitTimerStarted --> StartInterval[Start Timer Interval<br/>Set interval for updates<br/>Store in socket handler]
    
    StartInterval --> TimerCron[Timer Cron Job<br/>Runs every 1 second<br/>processLudoUserTimers]
    TimerCron --> GetActiveGames[SMEMBERS ludo_active_games<br/>Get all active game IDs]
    GetActiveGames --> ProcessEachGame[Process Each Game<br/>Parallel processing<br/>Max 5 concurrent]
    ProcessEachGame --> FetchMatch4[Fetch Match from Redis]
    FetchMatch4 --> CheckCompleted{Game Completed?<br/>status='completed'<br/>OR winner exists}
    CheckCompleted -->|Yes| RemoveFromActive[SREM ludo_active_games<br/>Remove from active set]
    CheckCompleted -->|No| CheckWinnerDeclared{Winner Declared?<br/>Check winner_declarations table}
    CheckWinnerDeclared -->|Yes| RemoveFromActive
    CheckWinnerDeclared -->|No| CheckContestType{Contest Type?}
    
    CheckContestType -->|Quick| CheckTimeLimit{5 Minutes Elapsed?<br/>start_time + 5min < now}
    CheckTimeLimit -->|Yes| DeclareByScore[Declare Winner by Score<br/>Highest score wins<br/>If tie, user1 wins]
    CheckTimeLimit -->|No| ContinueGame1[Continue Game<br/>Process timer logic]
    
    CheckContestType -->|Classic| CheckTurns{15 Turns Each?<br/>turnCount for user1 >= 15<br/>AND turnCount for user2 >= 15}
    CheckTurns -->|Yes| DeclareByScore
    CheckTurns -->|No| ContinueGame2[Continue Game<br/>Process timer logic]
    
    CheckContestType -->|Simple| CheckAllPiecesHome[Check All Pieces Home<br/>user1_pieces_home equals true<br/>OR user2_pieces_home equals true]
    CheckAllPiecesHome -->|Yes| DeclareWinner
    CheckAllPiecesHome -->|No| ContinueGame3[Continue Game<br/>Process timer logic]
    
    ContinueGame1 --> CheckTimerExpired{Timer Expired?<br/>user_time + 15s < now<br/>for current turn user}
    ContinueGame2 --> CheckTimerExpired
    ContinueGame3 --> CheckTimerExpired
    
    CheckTimerExpired -->|Yes| GetChances[Get User Chances<br/>from Redis<br/>chances object with userId key]
    GetChances --> DecrementChance{Chances > 0?}
    DecrementChance -->|Yes| Decrement[Decrement Chance<br/>chances object with userId key--<br/>SAVE to Redis<br/>Update match.user1_chance<br/>match.user2_chance]
    Decrement --> SwitchTurn[Switch Turn<br/>match.turn = opponent<br/>Update timestamps<br/>SAVE to Redis]
    DecrementChance -->|No| EndGameTimeout[End Game - Timeout<br/>match.status='completed'<br/>match.winner=opponent<br/>match.game_end_reason='opponent_timeout'<br/>SAVE to Redis]
    EndGameTimeout --> DeclareWinnerTimeout[Declare Winner by Timeout<br/>Process winner declaration<br/>for opponent]
    
    CheckTimerExpired -->|No| SendUpdate[Send Timer Update<br/>Calculate remaining times<br/>Get chances, scores, stats<br/>Create payload<br/>Emit to all sockets]
    
    %% ============================================================================
    %% QUIT GAME FLOW - Complete Details
    %% ============================================================================
    Handler4 --> QuitGame[quit:game Event]
    QuitGame --> DecryptData4[Decrypt User Data]
    DecryptData4 --> ValidateAuth3{Authenticated?}
    ValidateAuth3 -->|No| EmitError22[Emit Error]
    ValidateAuth3 -->|Yes| ValidateFields4{Required Fields?<br/>user_id, game_id, contest_id}
    ValidateFields4 -->|No| EmitError23[Emit Error]
    ValidateFields4 -->|Yes| FetchMatch5[Fetch Match from Redis]
    FetchMatch5 --> ValidateUser2{User in Match?}
    ValidateUser2 -->|No| EmitError24[Emit Error]
    ValidateUser2 -->|Yes| CheckGameStatus4{Game Completed?}
    CheckGameStatus4 -->|Yes| EmitError25[Emit Error]
    CheckGameStatus4 -->|No| GetOpponentId[Get Opponent ID<br/>user1_id or user2_id]
    GetOpponentId --> UpdateGameState[Update Game State<br/>match.status='quit'<br/>match.winner=opponent_id<br/>match.game_end_reason='opponent_quit'<br/>match.completed_at=now<br/>SAVE to Redis]
    UpdateGameState --> ProcessWinnerQuit[Process Winner Declaration<br/>for opponent<br/>Same flow as normal win]
    ProcessWinnerQuit --> FindOpponentSocket[Find Opponent Socket<br/>GET user_to_socket:opponent_id]
    FindOpponentSocket --> NotifyOpponentQuit[Notify Opponent<br/>io.to opponentSocketId<br/>game:quit:notification<br/>status='game_won'<br/>winner_id, quit_by]
    NotifyOpponentQuit --> SendQuitResponse[Send Quit Response<br/>socket.emit<br/>quit:game:response<br/>status='game_lost'<br/>winner_id=opponent]
    SendQuitResponse --> StopTimersQuit[Stop All Timers<br/>timerRegistry.unregisterTimer<br/>timerEventBus.emitTimerStop<br/>Emit stop:timer_updates]
    StopTimersQuit --> CleanupRedisQuit[Cleanup Redis Data<br/>DEL match:gameId<br/>DEL matchkey_userchance:gameId<br/>SREM ludo_active_games]
    
    %% ============================================================================
    %% DISCONNECT FLOW - Complete Details
    %% ============================================================================
    Handler6 --> Disconnect[disconnect Event]
    Disconnect --> GetUserId[Get User ID from Socket<br/>socket.user.user_id<br/>OR from Redis<br/>socket_to_user:socketId]
    GetUserId --> CheckSearching{Searching for Opponent?<br/>SELECT FROM<br/>pending_league_joins_by_status<br/>WHERE user_id, status_id='1'}
    CheckSearching -->|Yes| CancelMatchmaking[Cancel Matchmaking]
    CancelMatchmaking --> GetEntryFee2[Get Entry Fee<br/>FROM league_joins<br/>entry_fee]
    GetEntryFee2 --> ProcessRefund2[Process Refund<br/>Credit Wallet<br/>UPDATE user_wallet<br/>balance += entry_fee<br/>credit += entry_fee]
    ProcessRefund2 --> RecordRefund[INSERT INTO user_wallet_history<br/>type='credit'<br/>amount=entry_fee<br/>metadata='disconnect_cancellation'<br/>details='Find opponent cancelled - refund']
    RecordRefund --> DeletePending2[DELETE FROM<br/>pending_league_joins_by_status<br/>DELETE FROM<br/>pending_league_joins<br/>WHERE status_id, join_day<br/>league_id, server_id, joined_at]
    DeletePending2 --> UpdateLeagueStatus2[UPDATE league_joins<br/>SET status='cancelled'<br/>WHERE user_id, status_id<br/>join_month, joined_at]
    UpdateLeagueStatus2 --> UpdateLeagueStatusById2[UPDATE league_joins_by_id<br/>SET status='cancelled'<br/>WHERE id]
    CheckSearching -->|No| CleanupSocket[Cleanup Socket Resources]
    CleanupSocket --> UnregisterTimer[Unregister Timer<br/>timerRegistry.unregisterTimer<br/>timerEventBus.emitTimerStop]
    UnregisterTimer --> CleanupSocketMappings[Cleanup Socket Mappings<br/>DEL socket_to_user:socketId<br/>DEL user_to_socket:userId]
    
    %% ============================================================================
    %% STYLING
    %% ============================================================================
    classDef matchmaking fill:#e1f5ff,stroke:#01579b,stroke-width:2px
    classDef diceRoll fill:#fff4e1,stroke:#e65100,stroke-width:2px
    classDef pieceMove fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef timer fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef win fill:#ffebee,stroke:#b71c1c,stroke-width:2px
    classDef error fill:#ffcdd2,stroke:#c62828,stroke-width:2px
    classDef database fill:#e0f2f1,stroke:#004d40,stroke-width:2px
    classDef redis fill:#fff3e0,stroke:#e65100,stroke-width:2px
    
    class Matchmaking,LoadPending,CreateMatch,CreatePieces,CreateDice,UpdateLeagueJoins,DeletePending matchmaking
    class DiceRoll,ProcessDiceRoll,RollDice,ScoreDiceRoll,CheckGuaranteedSix,GenerateGuaranteedTurns,CheckFirstSix,CheckConsecutive,CheckThreeSixes diceRoll
    class PieceMove,ProcessMove,EvaluateMove,PerformKill,CheckKill,CheckHomeReach,ScoreMove pieceMove
    class TimerStart,TimerCron,CalculateTime,CheckTimerExpired,DecrementChance timer
    class DeclareWinner,ProcessWinner,CreditWallet,RecordTransaction,InsertWinnerDecl win
    class EmitError1,EmitError2,EmitError3,EmitError4,EmitError5,EmitError6,EmitError7,EmitError8,EmitError9,EmitError10,EmitError11,EmitError12,EmitError13,EmitError14,EmitError15,EmitError16,EmitError17,EmitError18,EmitError19,EmitError20,EmitError21,EmitError22,EmitError23,EmitError24,EmitError25 error
    class CreateMatchPairDB,CreatePieces,CreateDice,InsertDiceRoll,UpdatePieceDB,InsertKillAudit,InsertWinnerDecl,RecordTransaction,UpdateLeagueJoins,UpdateMatchPair database
    class StoreRedis,StoreUserChance,FetchMatch1,FetchMatch2,FetchMatch3,SaveMatch1,SaveMatch2,CleanupRedis,AddToActiveGames redis
```

## Complete Coverage of All Aspects:

### 1. **Database Operations (Cassandra)**
- **match_pairs**: Create, update status, query
- **game_pieces**: Create 4 pieces per user, update positions
- **dice_rolls_lookup**: Create dice lookup IDs
- **dice_rolls_data**: Insert every dice roll
- **league_joins**: Update opponent, match_pair_id, status
- **league_joins_by_id**: Fast lookup table updates
- **pending_league_joins**: Delete on match
- **pending_league_joins_by_status**: Delete on match/expiry
- **piece_kills**: Audit kill records
- **piece_moves**: Track all piece movements
- **user_wallet**: Credit/debit operations
- **user_wallet_history**: Transaction records
- **winner_declarations**: Win/loss records
- **sessions**: Session validation
- **users**: User profile data
- **user_by_mobile**: Mobile lookup

### 2. **Redis Operations**
- **match:gameId**: Complete match state storage
- **matchkey_userchance:gameId**: User chances tracking
- **ludo_active_games**: Set of active games
- **socket_to_user:socketId**: Socket to user mapping
- **user_to_socket:userId**: User to socket mapping
- **session:token**: Session caching
- **user_session_lookup:userId**: Session lookup
- **ludo_winner_declared:gameId**: Winner declaration flag
- **ludo_expiry_notified:userId**: Expiry warning flag

### 3. **Game Rules & Logic**
- **First Six Rule**: Must roll 6 before moving out
- **Guaranteed Six**: 3 guaranteed sixes in turns 6-10 if no six in first 5 rolls
- **Consecutive Sixes**: Track and penalize 3 consecutive sixes
- **Safe Squares**: 1, 9, 14, 22, 27, 35, 40, 48 (no kills)
- **Kill Positions**: 52 kill position mappings
- **Home Position**: 57 (exact reach required)
- **Piece States**: initial, 1-57, goal, finished
- **Turn Management**: Complex logic based on dice, piece state, kills

### 4. **Contest Types**
- **Simple**: All pieces home = win
- **Quick**: 5 minutes time limit, highest score wins
- **Classic**: 15 turns each, highest score wins

### 5. **Scoring System** (Complete from scoreConfig)
- **Dice Roll**: Base (dice × 10), Six (+10), First Six (+5), Consecutive (+2 each), Lucky 1 (+25)
- **Piece Move**: Kill (+10), Home Reach (+15), Safe Square (+2), Perfect Move (+5)
- **Achievements**: First piece out, all pieces out, consecutive kills, etc.
- **Time-based**: Fast turn bonus, slow turn penalty
- **Multipliers**: First game, weekend, streak bonuses

### 6. **Timer System**
- **15 seconds per turn**: MAX_TIMER_SECONDS
- **3 chances per user**: Decrement on timeout
- **Cron job**: Runs every 1 second
- **Active games tracking**: Redis set
- **Real-time updates**: Emit every second to connected sockets

### 7. **Bot Integration**
- **Bot start API**: POST /api/bot/start
- **Triggered**: When user in expiry window (10s-6s before expiry)
- **Bot user data**: FROM bot_user_ids table
- **Session data**: FROM sessions table

### 8. **Error Handling**
- **25+ error paths**: All validation failures covered
- **Error types**: validation, data, game, system, authentication
- **Error codes**: invalid_value, not_found, turn_expired, first_six_required, etc.

### 9. **Notification Events**
- **dice:roll:response**: Dice roll result
- **opponent:dice:roll:update**: Opponent dice roll
- **piece:move:response**: Piece move result
- **opponent:move:update**: Opponent piece move
- **timer_update**: Timer state updates
- **timer_started**: Timer started confirmation
- **timer_stopped**: Timer stopped
- **stop:timer_updates**: Stop timer command
- **game:won**: Game won notification
- **game:lost**: Game lost notification
- **game:quit:notification**: Opponent quit
- **quit:game:response**: Quit confirmation
- **opponent:response**: Opponent check result
- **connection:established**: Socket connection

### 10. **Wallet & Transactions**
- **Credit operations**: Win prize, refund entry fee
- **Debit operations**: Entry fee deduction
- **Balance tracking**: Real-time balance updates
- **Transaction history**: Complete audit trail
- **Metadata**: Detailed transaction metadata

### 11. **Session Management**
- **Session validation**: JWT + session token
- **Device validation**: device_id matching
- **Session caching**: Redis for performance
- **Session cleanup**: On disconnect/game end

### 12. **Match State Management**
- **Turn tracking**: turnCount per user
- **Previous turn**: Track for turn counting
- **Timestamps**: user1_time, user2_time, start_time
- **Connection counts**: user1_connection_count, user2_connection_count
- **Scores**: user1_score, user2_score, scores object
- **Pieces state**: Complete piece arrays with positions
- **Dice state**: Dice IDs and last roll info

This diagram now covers **ALL** main aspects of the Ludo game implementation!
