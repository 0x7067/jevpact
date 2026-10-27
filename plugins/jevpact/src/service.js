import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveKey, readStoredKey, storeKey } from './credentials.js';
import { call } from './rpc.js';
import { DEFAULT_MODEL, OPENROUTER_MODEL } from './jev.js';
import { codexHome, ensureState, profileSuffix, socketPath, stateDir, storedKeyPath } from './paths.js';

const exec = promisify(execFile);
const taskIdPattern = /^[0-9a-f-]{36}$/;
const labelSuffix = profileSuffix().replace('-', '.');
export const serviceLabels = { controller: `com.slopware.jevpact${labelSuffix}.controller`,
  health: `com.slopware.jevpact${labelSuffix}.health` };
const domain = () => `gui/${process.getuid()}`;
const agentPath = label => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const configPath = () => path.join(stateDir(), 'service.json');
const probePath = () => path.join(stateDir(), 'health-probe.mjs');
const runtimePath = version => path.join(stateDir(), 'runtime', version);

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function servicePlist({ label, args, interval = null, errorPath, environment = {} }) {
  const argumentsXml = args.map(arg => `      <string>${xml(arg)}</string>`).join('\n');
  const environmentXml = Object.entries(environment).map(([key, value]) =>
    `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key><dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key><true/>
  ${interval == null ? '<key>KeepAlive</key><true/>' : `<key>StartInterval</key><integer>${interval}</integer>`}
  <key>StandardErrorPath</key><string>${xml(errorPath)}</string>
  <key>Umask</key><integer>63</integer>
</dict></plist>
`;
}

async function writePrivate(file, contents) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function loaded(label) {
  try { await exec('/bin/launchctl', ['print', `${domain()}/${label}`], { timeout: 5000 }); return true; }
  catch (error) { if (typeof error.code === 'number') return false; throw error; }
}

async function bootout(label) {
  if (!await loaded(label)) return;
  await exec('/bin/launchctl', ['bootout', `${domain()}/${label}`], { timeout: 10000 });
  // launchctl can return before the old job disappears. A failed bootstrap's
  // subsequent print can otherwise mistake that retiring job for the new one.
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!await loaded(label)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Previous Jevpact job did not unload: ${label}`);
}

async function bootstrap(label) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await exec('/bin/launchctl', ['bootstrap', domain(), agentPath(label)], { timeout: 10000 });
      return;
    } catch (error) {
      if (await loaded(label)) return;
      if (attempt === 5) throw error;
      // launchd can briefly reject a re-bootstrap after bootout of the same label.
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function waitForVersion(version) {
  let lastResponse = 'none';
  // Restoring a long rollout can take minutes; a short wait rolls back a healthy update.
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const status = await call({ method: 'status' }, { timeout: 2500 });
      lastResponse = `${status.runtime?.version ?? 'unknown'}; restoring ${status.restoring ?? 'unknown'}`;
      if (status.runtime?.version === version && status.restoring === 0) return status;
    } catch { /* Startup is still in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Jevpact ${version} did not start and restore its tasks (last response: ${lastResponse})`);
}

async function waitForControllerStop(previousPid) {
  for (let attempt = 0; attempt < 120; attempt++) {
    let responsive = true;
    try { await call({ method: 'status' }, { timeout: 300 }); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) responsive = false;
    }
    let previousProcessAlive = false;
    if (Number.isSafeInteger(previousPid) && previousPid > 0) {
      try { process.kill(previousPid, 0); previousProcessAlive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!responsive && !previousProcessAlive) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The previous Jevpact controller did not stop');
}

async function findNode() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'node');
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return process.execPath;
}

async function readServiceConfig() {
  const contents = await readOptional(configPath());
  if (!contents) return null;
  const config = JSON.parse(contents);
  if (!Array.isArray(config.expectedThreads) || config.expectedThreads.some(id => !taskIdPattern.test(id))) {
    throw new Error('Invalid Jevpact service configuration');
  }
  return config;
}

async function stageRuntime(sourceRoot, version) {
  const target = runtimePath(version);
  const existing = await readOptional(path.join(target, '.codex-plugin', 'plugin.json'));
  if (existing) {
    if (JSON.parse(existing).version !== version) throw new Error('Installed runtime version mismatch');
    return target;
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of ['bin', 'src', '.codex-plugin', 'package.json']) {
      await cp(path.join(sourceRoot, entry), path.join(temporary, entry), { recursive: true });
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return target;
}

export async function installService({ sourceRoot, expectedThreads, nodePath } = {}) {
  if (process.platform !== 'darwin') throw new Error('The managed service is currently supported on macOS only');
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) throw new Error('An absolute plugin path is required');
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || !version.trim()) throw new Error('Invalid plugin version');
  const prior = await readServiceConfig();
  const provider = process.env.JEV_PROVIDER ?? prior?.provider ?? 'jev';
  if (!['jev', 'openrouter'].includes(provider)) throw new Error('JEV_PROVIDER must be jev or openrouter');
  const model = process.env.JEV_MODEL ?? (prior?.provider === provider ? prior.model : null)
    ?? (provider === 'openrouter' ? OPENROUTER_MODEL : DEFAULT_MODEL);
  if (typeof model !== 'string' || !model.trim()) throw new Error('Jev model must be configured');
  const ids = expectedThreads === undefined ? prior?.expectedThreads ?? [] : [...new Set(expectedThreads)];
  if (ids.some(id => !taskIdPattern.test(id))) throw new Error('Invalid expected task ID');
  const node = nodePath ?? await findNode();
  if (!path.isAbsolute(node)) throw new Error('Node path must be absolute');
  await access(node, constants.X_OK);
  const nodeVersion = (await exec(node, ['--version'], { timeout: 5000 })).stdout.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!nodeVersion || Number(nodeVersion[1]) < 22 || Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) < 13) {
    throw new Error('Jevpact requires Node.js 22.13 or later');
  }
  const freshKey = await resolveKey({ keyPath: null, provider });
  if (!freshKey && !await readStoredKey(storedKeyPath(provider))) throw new Error(provider === 'openrouter'
    ? 'Set OPENROUTER_API_KEY before installing the service' : 'Set JEV_API_KEY or JEV_TEST_KEY before installing the service');
  const sourceProbe = await readFile(path.join(sourceRoot, 'bin', 'jevpact-health.js'), 'utf8');
  const directory = await ensureState();
  const runtimeRoot = await stageRuntime(sourceRoot, version);
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  await mkdir(agents, { recursive: true, mode: 0o700 });
  const old = {};
  for (const label of Object.values(serviceLabels)) old[label] = await readOptional(agentPath(label));
  const controller = servicePlist({ label: serviceLabels.controller,
    args: [node, path.join(runtimeRoot, 'bin', 'jevpact.js'), 'serve'],
    errorPath: path.join(directory, 'controller.stderr.log'), environment: { CODEX_HOME: codexHome(),
      JEV_PROVIDER: provider, JEV_MODEL: model } });
  const health = servicePlist({ label: serviceLabels.health,
    args: [node, probePath(), '--plugin', runtimeRoot, ...ids.flatMap(id => ['--expect-thread', id])], interval: 60,
    errorPath: path.join(directory, 'health.stderr.log'), environment: { CODEX_HOME: codexHome(),
      JEVPACT_HEALTH_STATE_PATH: path.join(directory, 'health-state.json'), JEVPACT_SOCKET_PATH: socketPath() } });
  let previousPid = null;
  try { previousPid = (await call({ method: 'status' }, { timeout: 1000 })).pid; }
  catch { /* No responding controller before installation. */ }

  if (freshKey) await storeKey(freshKey, provider);
  await writePrivate(probePath(), sourceProbe);
  await bootout(serviceLabels.health);
  await bootout(serviceLabels.controller);
  try {
    try { await call({ method: 'stop' }); } catch { /* No remaining manual controller. */ }
    await waitForControllerStop(previousPid);
    await writePrivate(agentPath(serviceLabels.controller), controller);
    await writePrivate(agentPath(serviceLabels.health), health);
    await bootstrap(serviceLabels.controller);
    const status = await waitForVersion(version);
    await bootstrap(serviceLabels.health);
    await writePrivate(configPath(), JSON.stringify({ version, sourceRoot, runtimeRoot, nodePath: node, expectedThreads: ids, provider, model }) + '\n');
    return { version, pid: status.pid, expectedThreads: ids, runtimeRoot };
  } catch (error) {
    await bootout(serviceLabels.health).catch(() => {});
    await bootout(serviceLabels.controller).catch(() => {});
    for (const label of Object.values(serviceLabels)) {
      if (old[label] == null) await unlink(agentPath(label)).catch(() => {});
      else await writePrivate(agentPath(label), old[label]);
    }
    if (old[serviceLabels.controller]) await bootstrap(serviceLabels.controller).catch(() => {});
    if (old[serviceLabels.health]) await bootstrap(serviceLabels.health).catch(() => {});
    throw error;
  }
}

export async function serviceStatus({ sourceRoot } = {}) {
  const config = await readServiceConfig();
  let availableVersion = null;
  if (sourceRoot) {
    try { availableVersion = JSON.parse(await readFile(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version; }
    catch { /* A missing package cannot provide an update candidate. */ }
  }
  const controllerLoaded = await loaded(serviceLabels.controller);
  const healthLoaded = await loaded(serviceLabels.health);
  let runtime = null;
  try {
    const status = await call({ method: 'status' });
    runtime = { pid: status.pid, version: status.runtime?.version, attached: status.threads?.length ?? 0,
      expectedWatched: (config?.expectedThreads ?? []).every(id => status.threads?.some(thread => thread.sessionId === id
        && thread.supported && thread.observationMode === 'watch' && !thread.watchError)) };
  } catch { /* A stopped controller is reported through the loaded and runtime fields. */ }
  const state = await readOptional(path.join(stateDir(), 'health-state.json'));
  return { installed: !!config, controllerLoaded, healthLoaded, configuredVersion: config?.version ?? null,
    provider: config?.provider ?? 'jev', model: config?.model ?? DEFAULT_MODEL,
    availableVersion, updateRequired: !!config && !!availableVersion && availableVersion !== runtime?.version,
    runtime, health: state ? JSON.parse(state) : null };
}

export async function uninstallService() {
  if (process.platform !== 'darwin') throw new Error('The managed service is currently supported on macOS only');
  await bootout(serviceLabels.health);
  await bootout(serviceLabels.controller);
  for (const label of Object.values(serviceLabels)) {
    try { await unlink(agentPath(label)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of [configPath(), probePath(), storedKeyPath('jev'), storedKeyPath('openrouter'), path.join(stateDir(), 'health-state.json')]) {
    try { await unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rm(path.join(stateDir(), 'runtime'), { recursive: true, force: true });
  return { removed: true, retainedData: stateDir() };
}
