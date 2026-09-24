import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { servicePlist } from '../src/service.js';

const exec = promisify(execFile);

test('controller and health jobs are valid launchd plists with distinct lifecycles', async t => {
  if (process.platform !== 'darwin') return t.skip('launchd is macOS only');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jp-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, interval] of [['controller', null], ['health', 60]]) {
    const file = path.join(directory, `${name}.plist`);
    await writeFile(file, servicePlist({ label: `com.example.jevpact.${name}`,
      args: ['/opt/homebrew/bin/node', '/Users/example/Application Support/Jevpact/bin.js'], interval,
      errorPath: path.join(directory, 'stderr.log') }));
    await exec('/usr/bin/plutil', ['-lint', file]);
    const source = await readFile(file, 'utf8');
    assert.ok(source.includes(interval == null ? '<key>KeepAlive</key>' : '<key>StartInterval</key><integer>60</integer>'));
    assert.ok(source.includes('<key>Umask</key><integer>63</integer>'));
  }
});
