import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
if (!/^[a-zA-Z0-9.+-]+$/.test(manifest.version)) throw new Error('Invalid plugin version');
const output = path.join(root, 'dist', manifest.version);
await fs.mkdir(path.dirname(output), { recursive: true });
// A version is immutable. Bump the plugin version before rebuilding it.
await fs.mkdir(output);
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  for (const file of pack.files) {
    if (path.isAbsolute(file.path) || file.path.split('/').includes('..') || /^(?:\.git(?:\/|$)|eval\/)/.test(file.path)) {
      throw new Error('Repository internals or experiment data cannot be packaged');
    }
    const destination = path.join(output, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, file.path), destination);
    await fs.chmod(destination, file.mode);
  }
  console.log(output);
} catch (error) {
  // This directory was created exclusively by this invocation.
  await fs.rm(output, { recursive: true, force: true });
  throw error;
}
