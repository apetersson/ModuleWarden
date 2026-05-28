/**
 * benign-util v1.0.0
 * Simple string manipulation utilities.
 * No network requests, no file writes, no dynamic code execution.
 */

function capitalize(str) {
  if (typeof str !== 'string') return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  const len = maxLen || 100;
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function joinWith(separator, ...parts) {
  return parts.filter(Boolean).join(separator);
}

function padLeft(str, len, char) {
  str = String(str);
  char = char || ' ';
  while (str.length < len) str = char + str;
  return str;
}

module.exports = { capitalize, truncate, joinWith, padLeft };
