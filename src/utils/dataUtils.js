// ============================================================================
// Safely converts a value to a Date object
// ============================================================================
function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

// ============================================================================
// Safely parses JSON data
// ============================================================================
function safeJSONParse(value) {
  if (!value) return undefined;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return undefined;
  }
}

// ============================================================================
// Safely converts a value to a float number
// ============================================================================
function toFloat(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value?.toNumber === 'function') {
    try {
      return value.toNumber();
    } catch (err) {
      return toFloat(value.toString());
    }
  }
  if (typeof value?.toString === 'function') {
    return toFloat(value.toString());
  }
  return Number(value) || 0;
}

// ============================================================================
// Gets a value from a database row (supports both Map and object)
// ============================================================================
function getRowValue(row, column) {
  if (!row) return undefined;
  if (typeof row.get === 'function') return row.get(column);
  return row[column];
}

// ============================================================================
// Normalizes UUID value to string
// ============================================================================
function normalizeUuid(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value?.toString === 'function') return value.toString();
  return String(value);
}

// ============================================================================
// Sanitizes and splits league IDs from CSV string
// ============================================================================
function sanitizeLeagueIds(leagueIdsCsv) {
  if (!leagueIdsCsv) return [];
  return leagueIdsCsv
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// ============================================================================
// Resolves opponent league ID with fallback
// ============================================================================
function resolveOpponentLeagueId(primary, fallback) {
  if (typeof primary === 'string') {
    const trimmed = primary.trim();
    if (trimmed) {
      return trimmed;
    }
  } else if (primary) {
    return primary;
  }
  return fallback || '';
}

// ============================================================================
// Converts array to interface slice (matching Go implementation)
// ============================================================================
function toInterfaceSlice(inArray) {
  if (!Array.isArray(inArray)) return inArray;
  return inArray.map((v) => v);
}

module.exports = {
  toDate,
  safeJSONParse,
  toFloat,
  getRowValue,
  normalizeUuid,
  sanitizeLeagueIds,
  resolveOpponentLeagueId,
  toInterfaceSlice
};
