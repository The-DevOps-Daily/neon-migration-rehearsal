import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

// A small .env reader so the scripts need no dependency beyond pg.
if (existsSync(`${ROOT}/.env`)) {
  for (const line of readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

export function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}
