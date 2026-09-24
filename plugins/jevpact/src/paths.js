import os from 'node:os';
import path from 'node:path';
import { mkdir, lstat, chmod } from 'node:fs/promises';

export const runtimeDir = () => path.join(os.tmpdir(), `jevpact-${process.getuid?.() ?? os.userInfo().username}`);
export const socketPath = () => path.join(runtimeDir(), 'controller.sock');
export const stateDir = () => process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Jevpact')
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Jevpact')
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'jevpact');
// Persistent state survives OS temporary cleanup and plugin upgrades.
export const historyDir = () => process.env.JEVPACT_HISTORY_DIR || stateDir();
export const storedKeyPath = () => path.join(stateDir(), 'credential');
export async function ensureState() {
  const dir = stateDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Unsafe Jevpact state directory');
  }
  await chmod(dir, 0o700);
  return dir;
}
export async function ensureRuntime() {
  const dir = runtimeDir();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Unsafe Jevpact runtime directory');
  }
  await chmod(dir, 0o700);
  return dir;
}
