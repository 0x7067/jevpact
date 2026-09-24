import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureState, storedKeyPath } from './paths.js';
const exec = promisify(execFile);

/** TEST precedes API; launchctl covers an already-open GUI's older environment. */
export async function resolveKey({ env = process.env, platform = process.platform, globalValue,
  keyPath = platform === process.platform ? storedKeyPath() : null } = {}) {
  const readGlobal = globalValue ?? (async name => {
    if (platform !== 'darwin') return '';
    try { return (await exec('/bin/launchctl', ['getenv', name], { timeout: 1000 })).stdout.trim(); }
    catch { return ''; }
  });
  return env.JEV_TEST_KEY || await readGlobal('JEV_TEST_KEY') || env.JEV_API_KEY || await readGlobal('JEV_API_KEY')
    || (keyPath ? await readStoredKey(keyPath) : '');
}

export async function readStoredKey(keyPath = storedKeyPath()) {
  let info;
  try { info = await lstat(keyPath); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (info.mode & 0o077) !== 0) throw new Error('Unsafe Jevpact credential file');
  return (await readFile(keyPath, 'utf8')).trim();
}

export async function storeKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('A Jev key is required');
  const directory = await ensureState();
  const temporary = path.join(directory, `credential.${randomUUID()}.tmp`);
  await writeFile(temporary, key.trim() + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, storedKeyPath());
}
