import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimingPacket, sourceRequest } from '../src/timing-context.js';

test('timing input keeps the actual user request and a complete ordinary heartbeat assignment', () => {
  assert.equal(sourceRequest('<in-app-browser-context>ambient</in-app-browser-context>\n## My request:\nFix the rollout reader.').text,
    'Fix the rollout reader.');
  const heartbeat = sourceRequest(`<heartbeat><instructions>${'Check the installed runtime. '.repeat(90)}</instructions></heartbeat>`);
  assert.equal(heartbeat.origin, 'heartbeat');
  assert.equal(heartbeat.truncated, false);
  assert.ok(heartbeat.text.length > 1800);
});

test('timing packet uses the latest source request and current conclusion without stale older pending claims', () => {
  const snapshot = {
    turnId: 'turn-3', messages: [{ role: 'assistant', turnId: 'turn-3', sequence: 30, text: 'Installed and verified.' }],
    recentUserRequests: [
      { turnId: 'turn-1', sequence: 10, origin: 'ordinary', text: 'Fix the broken install.', truncated: false },
      { turnId: 'turn-2', sequence: 20, origin: 'ordinary', text: 'Check the running daemon.', truncated: false },
      { turnId: 'turn-3', sequence: 29, origin: 'ordinary', text: 'Finish it.', truncated: false },
    ],
    recentFinalReports: [
      { turnId: 'turn-1', sequence: 15, text: 'The daemon is still stopped.', truncated: false },
      { turnId: 'turn-3', sequence: 30, text: 'Installed and verified.', truncated: false, prompted: false },
    ],
  };
  const { packet, metadata } = buildTimingPacket(snapshot);
  assert.equal(metadata.available, true);
  assert.equal(packet.currentUser.text, 'Finish it.');
  assert.deepEqual(packet.sourceRequests.map(request => request.text), ['Check the running daemon.']);
  assert.equal(packet.currentReport.text, 'Installed and verified.');
  assert.equal(Object.hasOwn(packet, 'pendingClaims'), false);
});

test('referential follow-up includes its previous answer, while truncated current evidence waits', () => {
  const snapshot = {
    turnId: 'turn-2', messages: [{ role: 'assistant', turnId: 'turn-2', sequence: 20, text: 'Here is the walkthrough.' }],
    recentUserRequests: [
      { turnId: 'turn-1', sequence: 10, origin: 'ordinary', text: 'Create a visual walkthrough.', truncated: false },
      { turnId: 'turn-2', sequence: 19, origin: 'ordinary', text: "Where's my walkthrough?", truncated: false },
    ],
    recentFinalReports: [
      { turnId: 'turn-1', sequence: 15, text: 'The first image was prepared.', truncated: false },
      { turnId: 'turn-2', sequence: 20, text: 'Here is the walkthrough.', truncated: false, prompted: false },
    ],
  };
  assert.equal(buildTimingPacket(snapshot).packet.referentPreviousFinal.text, 'The first image was prepared.');
  snapshot.recentUserRequests[1].truncated = true;
  assert.equal(buildTimingPacket(snapshot).metadata.available, false);
});
