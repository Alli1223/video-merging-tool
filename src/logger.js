'use strict';

// Tiny shared logger used by the main process and its helper modules. Writes
// timestamped lines to a file (set once the app knows its userData path) and
// mirrors them to the console. Lines logged before the file is configured are
// buffered and flushed when setLogFile() is called.

const fs = require('fs');

let logFile = null;
let buffer = [];

function stamp(level, args) {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  });
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${parts.join(' ')}\n`;
}

function write(level, args) {
  const line = stamp(level, args);
  if (logFile) {
    try { fs.appendFileSync(logFile, line); } catch (_) { /* ignore */ }
  } else {
    buffer.push(line);
    if (buffer.length > 1000) buffer.shift();
  }
  (level === 'error' ? console.error : console.log)(line.trimEnd());
}

function setLogFile(p) {
  logFile = p;
  if (buffer.length) {
    try { fs.appendFileSync(logFile, buffer.join('')); } catch (_) { /* ignore */ }
    buffer = [];
  }
}

module.exports = {
  setLogFile,
  getLogFile: () => logFile,
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args)
};
