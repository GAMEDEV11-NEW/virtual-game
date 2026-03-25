// ============================================================================
// Gets current date as ISO string
// ============================================================================
function toISOString(date = null) {
  if (!date) {
    return new Date().toISOString();
  }
  if (date instanceof Date) {
    return date.toISOString();
  }
  return new Date(date).toISOString();
}

// ============================================================================
// Gets current timestamp in milliseconds
// ============================================================================
function getCurrentTimestamp() {
  return Date.now();
}

// ============================================================================
// Gets current date object
// ============================================================================
function getCurrentDate() {
  return new Date();
}

// ============================================================================
// Calculates time difference in seconds
// ============================================================================
function getTimeDifferenceSeconds(startTime, endTime = null) {
  const start = startTime instanceof Date ? startTime : new Date(startTime);
  const end = endTime ? (endTime instanceof Date ? endTime : new Date(endTime)) : new Date();
  return Math.floor((end - start) / 1000);
}

// ============================================================================
// Calculates time difference in milliseconds
// ============================================================================
function getTimeDifferenceMs(startTime, endTime = null) {
  const start = startTime instanceof Date ? startTime : new Date(startTime);
  const end = endTime ? (endTime instanceof Date ? endTime : new Date(endTime)) : new Date();
  return end - start;
}

// ============================================================================
// Checks if a time has expired based on timeout
// ============================================================================
function isTimeExpired(startTime, timeoutSeconds, currentTime = null) {
  const diffSeconds = getTimeDifferenceSeconds(startTime, currentTime);
  return diffSeconds >= timeoutSeconds;
}

// ============================================================================
// Formats date to YYYY-MM-DD string
// ============================================================================
function formatDate(date = null) {
  const d = date ? (date instanceof Date ? date : new Date(date)) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ============================================================================
// Gets year-month string (YYYY-MM)
// ============================================================================
function getYearMonth(date = null) {
  const d = date ? (date instanceof Date ? date : new Date(date)) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ============================================================================
// Adds milliseconds to a date and returns ISO string
// ============================================================================
function addMsToISO(ms, baseDate = null) {
  const base = baseDate ? (baseDate instanceof Date ? baseDate : new Date(baseDate)) : new Date();
  const result = new Date(base.getTime() + ms);
  return result.toISOString();
}

// ============================================================================
// Adds seconds to a date and returns ISO string
// ============================================================================
function addSecondsToISO(seconds, baseDate = null) {
  return addMsToISO(seconds * 1000, baseDate);
}

module.exports = {
  toISOString,
  getCurrentTimestamp,
  getCurrentDate,
  getTimeDifferenceSeconds,
  getTimeDifferenceMs,
  isTimeExpired,
  formatDate,
  getYearMonth,
  addMsToISO,
  addSecondsToISO
};
