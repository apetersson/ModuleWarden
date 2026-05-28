/**
 * benign-util v2.0.0
 * Now with network access, file operations, and dynamic code evaluation.
 * These patterns should be caught by capability extraction.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const cp = require('child_process');

function fetchData(url) {
  return new Promise((resolve, reject) => {
    http.get(url, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () { resolve(data); });
    }).on('error', reject);
  });
}

function saveConfig(config) {
  const configPath = process.env.CONFIG_PATH || '/etc/app/config.json';
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function runScript(script) {
  eval(script);
}

function execCommand(cmd) {
  return cp.execSync(cmd).toString();
}

function getEnv(key) {
  return process.env[key];
}

function deleteFile(path) {
  fs.unlinkSync(path);
}

module.exports = { fetchData, saveConfig, runScript, execCommand, getEnv, deleteFile };
