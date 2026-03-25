const sessionService = require('../../utils/sessionService');
const cassandraClient = require('../../services/cassandra/client');
const { processCommonDisconnect, getUserIDFromSocket: baseGetUserIDFromSocket } = require('../common/baseHandlers');
const { safeJSONParse } = require('../../utils/dataUtils');
const { config } = require('../../utils/config');

const SERVER_ID = config.serverId;

const {
    GAME_STATUS,
    getCurrentMonth,
    getTodayString
} = require('../../constants');

const SEARCH_STATUS_ID = GAME_STATUS.PENDING;
const CANCELLED_STATUS = GAME_STATUS.CANCELLED;
const CURRENT_MONTH = getCurrentMonth;
const CURRENT_DAY = getTodayString;

// ============================================================================
// Read wallet snapshot for a user
// ============================================================================
async function fetchWalletSnapshot(userID) {
    if (userID == null) {
        return { balance: 0, credit: 0, debit: 0 };
    }
    const query = `
        SELECT balance, credit, debit 
        FROM user_wallet 
        WHERE user_id = ?
    `;

    const result = await cassandraClient.execute(query, [userID], { prepare: true });
    if (result.rowLength === 0) {
        return { balance: 0, credit: 0, debit: 0 };
    }
    const row = result.rows[0];
    return {
        balance: parseFloat(row.balance) || 0,
        credit: parseFloat(row.credit) || 0,
        debit: parseFloat(row.debit) || 0,
    };
}

// ============================================================================
// Build metadata string for wallet history
// ============================================================================
const formatRefundMetadata = (entry, txnTime) =>
    `PAYMENT=credit;action=disconnect_cancellation;league_id=${entry.league_id};contest_id=${entry.contest_id || ''};original_join_time=${entry.joined_at};refund_time=${txnTime}`;

// ============================================================================
// Check if the user is in pending matchmaking
// ============================================================================
async function checkIfUserIsSearchingForOpponent(userID) {
    try {
        if (userID == null) {
            return null;
        }
        const session = await sessionService.getSession(userID);
        if (!session || !session.is_active) {
            return null;
        }

        const query = `
            SELECT user_id, status_id, joined_at, league_id, id, extra_data
            FROM pending_league_joins_by_status 
            WHERE user_id = ? AND status_id = ?
        `;

        const result = await cassandraClient.execute(query, [userID, SEARCH_STATUS_ID], { prepare: true });

        if (result.rows.length > 0) {
            const row = result.rows[0];
            return {
                user_id: row.user_id,
                contest_id: row.league_id,
                l_id: row.id.toString(),
                status_id: row.status_id,
                joined_at: row.joined_at,
                league_id: row.league_id,
                id: row.id,
                extra_data: row.extra_data,
                table_source: 'pending_league_joins_by_status'
            };
        }

        return null;
    } catch (error) {
        return null;
    }
}

// ============================================================================
// Process refund for cancelled league join
// ============================================================================
async function processRefund(userID, entry) {
    try {
        const entryFee = await getEntryFeeFromLeagueJoins(userID, entry);
        if (!entryFee || entryFee <= 0) {
            return true;
        }

        const walletCreditResult = await creditUserWallet(userID, entryFee);
        await recordRefundTransaction(userID, entry, entryFee, walletCreditResult.balanceAfter);
        return true;
    } catch (_) {
        return false;
    }
}

// ============================================================================
// Determine entry fee from league joins
// ============================================================================
async function getEntryFeeFromLeagueJoins(userID, entry) {
    try {
        const entryId = entry.id ? entry.id.toString() : null;
        
        if (entryId) {
            try {
                const { DB_QUERIES } = require('../../constants');
                const entryResult = await cassandraClient.execute(DB_QUERIES.SELECT_LEAGUE_JOIN_BY_ID, [entryId], { prepare: true });
                
                if (entryResult.rowLength > 0) {
                    const entryRow = entryResult.rows[0];
                    
                    const userIdMatch = !userID || !entryRow.user_id || entryRow.user_id.toString() === userID.toString();
                    if (userIdMatch) {
                        if (entryRow.entry_fee !== null && entryRow.entry_fee !== undefined) {
                            const entryFee = parseFloat(entryRow.entry_fee);
                            if (Number.isFinite(entryFee) && entryFee > 0) {
                                return entryFee;
                            }
                        }
                        
                        const parsed = safeJSONParse(entryRow.extra_data) || {};
                        if (parsed && parsed.entry_fee) {
                            const entryFee = parseFloat(parsed.entry_fee);
                            if (Number.isFinite(entryFee) && entryFee > 0) {
                                return entryFee;
                            }
                        }
                    }
                }
            } catch (err) {
            }
        }
        
        const query = `
            SELECT extra_data, entry_fee, id
            FROM league_joins 
            WHERE user_id = ? AND status_id = ? AND join_month = ?
        `;

        const result = await cassandraClient.execute(
            query,
            [userID, SEARCH_STATUS_ID, CURRENT_MONTH()],
            { prepare: true }
        );

        if (result.rowLength === 0) {
            return 0;
        }

        let matchedRow = null;

        if (entryId) {
            matchedRow = result.rows.find(row => {
                const rowId = row.id ? row.id.toString() : null;
                return rowId === entryId;
            });
        }

        if (!matchedRow && entry.joined_at) {
            matchedRow = result.rows.find(row => {
                const rowJoinedAt = row.joined_at;
                if (rowJoinedAt && entry.joined_at) {
                    return rowJoinedAt.getTime && entry.joined_at.getTime &&
                        rowJoinedAt.getTime() === entry.joined_at.getTime();
                }
                return false;
            });
        }

        if (!matchedRow && result.rows.length > 0) {
            matchedRow = result.rows[0];
        }

        if (!matchedRow) {
            return 0;
        }

        if (matchedRow.entry_fee !== null && matchedRow.entry_fee !== undefined) {
            const entryFee = parseFloat(matchedRow.entry_fee);
            if (Number.isFinite(entryFee) && entryFee > 0) {
                return entryFee;
            }
        }

        const parsed = safeJSONParse(matchedRow.extra_data) || {};
        if (parsed && parsed.entry_fee) {
            const entryFee = parseFloat(parsed.entry_fee);
            if (Number.isFinite(entryFee) && entryFee > 0) {
                return entryFee;
            }
        }

        return 0;
    } catch (_) {
        return 0;
    }
}

// ============================================================================
// Credit the user's wallet (RMW)
// ============================================================================
async function creditUserWallet(userID, amount) {
    try {
        const snapshot = await fetchWalletSnapshot(userID);
        const updated = {
            balance: snapshot.balance + amount,
            credit: snapshot.credit + amount,
            debit: snapshot.debit,
        };

        const query = `
            UPDATE user_wallet 
            SET balance = ?, credit = ?, debit = ?, last_updated = ?
            WHERE user_id = ?
        `;

        await cassandraClient.execute(query, [
            updated.balance.toString(),
            updated.credit.toString(),
            updated.debit.toString(),
            new Date(),
            userID,
        ], { prepare: true });

        return {
            success: true,
            balanceAfter: updated.balance,
            previousBalance: snapshot.balance,
            creditAfter: updated.credit,
            previousCredit: snapshot.credit,
            debitAfter: updated.debit,
            previousDebit: snapshot.debit,
        };
    } catch (_) {
        return {
            success: false,
            balanceAfter: 0,
            previousBalance: 0,
            creditAfter: 0,
            previousCredit: 0,
            debitAfter: 0,
            previousDebit: 0,
        };
    }
}

// ============================================================================
// Persist refund transaction into wallet history
// ============================================================================
async function recordRefundTransaction(userID, entry, amount, balanceAfter) {
    try {
        const { getCurrentDate } = require('../../utils/dateUtils');
        const txnTime = getCurrentDate();
        const txnMonth = CURRENT_MONTH();
        const txnId = entry.id || require('crypto').randomUUID();

        const query = `
            INSERT INTO user_wallet_history (
                user_id, type, txn_month, txn_time, txn_id, 
                amount, balance_after, metadata, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        await cassandraClient.execute(query, [
            userID,
            'credit',
            txnMonth,
            txnTime,
            txnId,
            amount.toString(),
            balanceAfter.toString(),
            formatRefundMetadata(entry, txnTime),
            'Find opponent cancelled - refund',
        ], { prepare: true });
        return true;
    } catch (_) {
        return false;
    }
}

// ============================================================================
// Delete pending entry by status index
// ============================================================================
async function deletePendingLeagueJoinByStatus(userID, joinedAt) {
    const query = `
        DELETE FROM pending_league_joins_by_status 
        WHERE user_id = ? AND status_id = ? AND joined_at = ?
    `;
    await cassandraClient.execute(query, [userID, SEARCH_STATUS_ID, joinedAt], { prepare: true });
}

// ============================================================================
// Delete pending entry by day
// ============================================================================
async function deletePendingLeagueJoinEntry(entry, joinDay) {
    const query = `
        DELETE FROM pending_league_joins 
        WHERE status_id = ? AND join_day = ? AND league_id = ? AND server_id = ? AND joined_at = ?
    `;
    const serverId = entry.server_id || SERVER_ID;
    await cassandraClient.execute(query, [SEARCH_STATUS_ID, joinDay, entry.league_id, serverId, entry.joined_at], { prepare: true });
}

// ============================================================================
// Update league join status to cancelled
// ============================================================================
async function updateLeagueJoinStatusToCancelled(userID, entry, joinMonth) {
    const query = `
        UPDATE league_joins 
        SET status = ?, updated_at = ?
        WHERE user_id = ? AND status_id = ? AND join_month = ? AND joined_at = ?
    `;
    await cassandraClient.execute(query, [
        CANCELLED_STATUS,
        new Date(),
        userID,
        SEARCH_STATUS_ID,
        joinMonth,
        entry.joined_at
    ], { prepare: true });
    
    if (entry.id) {
        try {
            const { updateLeagueJoinById } = require('../../services/ludo/gameService');
            await updateLeagueJoinById(entry.id, null, CANCELLED_STATUS, {
                statusId: SEARCH_STATUS_ID
            });
        } catch (err) {
        }
    }
}

// ============================================================================
// Cancel matchmaking and trigger refund
// ============================================================================
async function cancelFindOpponentProcess(userID, entry) {
    try {
        await deletePendingLeagueJoinByStatus(userID, entry.joined_at);
        await deletePendingLeagueJoinEntry(entry, CURRENT_DAY());
        await updateLeagueJoinStatusToCancelled(userID, entry, CURRENT_MONTH());

        await processRefund(userID, entry);

        return true;

    } catch (error) {
        return false;
    }
}

// ============================================================================
// Handle disconnect logic for a socket
// ============================================================================
async function handleSocketDisconnect(io, socket, reason) {
    try {
        const userID = await getUserIDFromSocket(socket);
        if (!userID) {
            return;
        }

        await cancelFindOpponentIfSearching(userID);

        await cleanupSocketResources(socket, userID);

    } catch (error) {
    }
}

const getUserIDFromSocket = baseGetUserIDFromSocket;

// ============================================================================
// Cancel matchmaking if applicable
// ============================================================================
async function cancelFindOpponentIfSearching(userID) {
    try {
        const searchEntry = await checkIfUserIsSearchingForOpponent(userID);

        if (searchEntry) {
            await cancelFindOpponentProcess(userID, searchEntry);
        }
    } catch (error) {
    }
}

// ============================================================================
// Perform cleanup work for a user/socket
// ============================================================================
async function cleanupSocketResources(socket, userID) {
    try {
        await processCommonDisconnect(socket, userID, socket.id, {
            timerHandlerKeys: ['timerHandler'],
            cleanupUserToSocket: false
        });
    } catch (error) {
    }
}

// ============================================================================
// Register disconnect handler
// ============================================================================
function registerDisconnectHandler(io, socket) {
    socket.on('disconnect', async (reason) => {
        await handleSocketDisconnect(io, socket, reason);
    });

}

module.exports = {
    registerDisconnectHandler
};
