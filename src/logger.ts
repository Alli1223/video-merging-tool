// Tiny shared logger used by the main process and its helper modules. Writes
// timestamped lines to a file (set once the app knows its userData path) and
// mirrors them to the console. Lines logged before the file is configured are
// buffered and flushed when setLogFile() is called.

import fs from 'fs';

let logFile: string | null = null;
let buffer: string[] = [];

function stamp(level: LogLevel, args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  });
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${parts.join(' ')}\n`;
}

function write(level: LogLevel, args: unknown[]): void {
  const line = stamp(level, args);
  if (logFile) {
    try { fs.appendFileSync(logFile, line); } catch { /* ignore */ }
  } else {
    buffer.push(line);
    if (buffer.length > 1000) buffer.shift();
  }
  (level === 'error' ? console.error : console.log)(line.trimEnd());
}

export function setLogFile(p: string): void {
  logFile = p;
  if (buffer.length) {
    try { fs.appendFileSync(logFile, buffer.join('')); } catch { /* ignore */ }
    buffer = [];
  }
}

export function getLogFile(): string | null {
  return logFile;
}

export function info(...args: unknown[]): void { write('info', args); }
export function warn(...args: unknown[]): void { write('warn', args); }
export function error(...args: unknown[]): void { write('error', args); }
