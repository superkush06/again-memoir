// Explicit, opt-in live test. Creates temporary rooms and removes them in finally.
// Run: npx tsx src/multiplayer/live-smoke.ts
import assert from 'node:assert/strict';
import { createMultiplayerClient } from './index';
import type { SceneSpec } from '../types';

const host = createMultiplayerClient();
const guest = createMultiplayerClient();
const other = createMultiplayerClient();
async function until(condition: () => boolean, label: string) {
  const expires = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > expires) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
try {
  await host.create('Smoke host', 'desktop');
  // No polling between these calls: this is the App's "share current world" flow.
  assert.ok(host.snapshot, 'create resolves only when the room snapshot is ready');
  await host.selectScene('already-open-memory', null);
  await guest.join(host.snapshot!.code, 'Smoke headset', 'vr');
  await other.create('Isolated phone', 'mobile');
  await until(() => host.snapshot?.members.length === 2 && guest.snapshot?.members.length === 2 && other.snapshot?.members.length === 1, 'membership');
  assert.equal(guest.snapshot!.memoryId, 'already-open-memory');
  assert.notEqual(host.identity, guest.identity);
  assert.notEqual(host.snapshot!.code, other.snapshot!.code);
  await assert.rejects(guest.selectScene('unauthorized', null), /Only the host/);
  const scene: SceneSpec = {
    memoryId: 'smoke-memory', title: 'Smoke photo', environment: 'gallery', skyColor: '#ffffff', floorColor: '#444444', accentColor: '#aabbcc',
    ambientLight: 1, description: 'Shared reconstruction metadata', generatedBy: 'fallback', depthLayers: [],
    reconstruction: {
      version: 1, kind: 'depth-mesh', depthSource: 'depth-anything-v2',
      sourceUrl: '/uploads/reconstructions/smoke-source.jpg', depthUrl: '/uploads/reconstructions/smoke-depth.png',
      width: 1024, height: 768, near: 2, far: 12, fov: 60,
      completionUrl: '/uploads/reconstructions/smoke-world.json',
    },
  };
  await host.selectScene('smoke-memory', scene);
  await until(() => guest.snapshot?.memoryId === 'smoke-memory', 'memory sync');
  assert.deepEqual(guest.snapshot!.scene?.reconstruction, scene.reconstruction);
  assert.equal(other.snapshot!.memoryId, null);
  await assert.rejects(host.selectScene('smoke-memory', {
    ...scene, reconstruction: { ...scene.reconstruction!, depthUrl: 'https://example.com/untrusted.png' },
  }), /Invalid photo reconstruction/);
  await guest.updatePose({ position: [2, 1.7, -1], rotation: [0, 0, 0, 1] });
  await until(() => host.snapshot?.members.find(person => person.id === guest.identity)?.pose?.position[0] === 2, 'pose sync');
  await host.leave();
  await until(() => guest.snapshot?.hostId === guest.identity && guest.snapshot?.members.length === 1, 'host handoff');
  await guest.selectScene('new-host-memory', null);
  console.log('PASS: Maincloud create then immediate scene selection, create/join, isolated rooms, host authority, reconstruction sync and validation, pose sync, and host handoff.');
} finally {
  await Promise.allSettled([host.leave(), guest.leave(), other.leave()]);
  host.disconnect(); guest.disconnect(); other.disconnect();
}
