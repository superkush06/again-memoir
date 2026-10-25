import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Identity } from 'spacetimedb';
import { DbConnection, type DbConnectionBuilder } from './bindings';
import { createMultiplayerClient } from './index';
import type { SceneSpec } from '../types';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Reducer acknowledgements intentionally precede subscription rows by 25ms. */
function fakeTransport() {
  const original = DbConnection.builder;
  const identity = Identity.zero();
  type Room = { code: string; host: Identity; memoryId: string; sceneJson: string };
  type Member = { identity: Identity; name: string; device: string; color: string; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
  let room: Room | null = null;
  let member: Member | null = null;
  let publishedRoom: Room | null = null;
  let publishedMember: Member | null = null;
  let onConnect: Parameters<DbConnectionBuilder['onConnect']>[0] | undefined;
  let onApplied: (() => void) | undefined;
  const callbacks = new Set<() => void>();
  const table = <T,>(rows: () => T[]) => ({ iter: rows, onInsert: (fn: () => void) => callbacks.add(fn), onDelete: (fn: () => void) => callbacks.add(fn), onUpdate: (fn: () => void) => callbacks.add(fn) });
  const publish = () => {
    publishedRoom = room ? { ...room } : null;
    publishedMember = member ? { ...member } : null;
    for (const callback of callbacks) callback();
  };
  const fake = {
    isActive: false,
    db: { myRoom: table(() => publishedRoom ? [publishedRoom] : []), roomMembers: table(() => publishedMember ? [publishedMember] : []) },
    reducers: {
      createRoom: async ({ code, name, device }: { code: string; name: string; device: string }) => {
        room = { code, host: identity, memoryId: '', sceneJson: 'null' };
        member = { identity, name, device, color: '#c86642', x: 0, y: 1.6, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 };
        setTimeout(publish, 25);
      },
      selectScene: async ({ memoryId, sceneJson }: { memoryId: string; sceneJson: string }) => {
        assert.ok(room, 'server membership must exist');
        room = { ...room, memoryId, sceneJson };
        publish();
      },
      updatePose: async (pose: Omit<Member, 'identity' | 'name' | 'device' | 'color'>) => {
        assert.ok(member); member = { ...member, ...pose }; publish();
      },
      leaveRoom: async () => { room = null; member = null; publish(); },
    },
    subscriptionBuilder: () => subscription,
    disconnect: () => { fake.isActive = false; room = null; member = null; },
  };
  const connection = fake as unknown as DbConnection;
  const subscription = {
    onApplied: (fn: () => void) => { onApplied = fn; return subscription; },
    onError: () => subscription,
    subscribe: () => { queueMicrotask(() => onApplied?.()); },
  };
  const builder = {
    withUri: () => builder, withDatabaseName: () => builder, withAutomaticReconnect: () => builder,
    onConnect: (fn: NonNullable<typeof onConnect>) => { onConnect = fn; return builder; },
    onAutomaticReconnect: () => builder, onConnectError: () => builder, onDisconnect: () => builder,
    build: () => { setTimeout(() => { fake.isActive = true; onConnect?.(connection, identity, 'test'); }, 0); return connection; },
  };
  DbConnection.builder = () => builder as unknown as DbConnectionBuilder;
  return { publish, restore: () => { DbConnection.builder = original; } };
}

test('create waits for delayed view delivery, then immediate selectScene succeeds', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  try {
    await client.create('Host');
    assert.equal(client.snapshot?.members.length, 1);
    await client.selectScene('already-open-memory', null);
    await delay(0);
    assert.equal(client.snapshot?.memoryId, 'already-open-memory');
  } finally { client.disconnect(); fake.restore(); }
});

test('pose snapshots preserve the scene object reference', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  const scene: SceneSpec = { memoryId: 'one', title: 'One', environment: 'garden', skyColor: '#ffffff', floorColor: '#444444', accentColor: '#aabbcc', ambientLight: 1, description: 'A garden', generatedBy: 'fallback', depthLayers: [] };
  try {
    await client.create('Host');
    await client.selectScene('one', scene);
    await delay(0);
    const first = client.snapshot!.scene;
    await client.updatePose({ position: [2, 1, 3], rotation: [0, 0, 0, 1] });
    await delay(0);
    assert.equal(client.snapshot!.scene, first);
    assert.equal(client.snapshot!.members[0].pose?.position[0], 2);
  } finally { client.disconnect(); fake.restore(); }
});

const reconstructedScene: SceneSpec = {
  memoryId: 'photo-one', title: 'Photo', environment: 'garden', skyColor: '#ffffff', floorColor: '#444444', accentColor: '#aabbcc',
  ambientLight: 1, description: 'Reconstructed photo', generatedBy: 'fallback', depthLayers: [],
  reconstruction: {
    version: 1, kind: 'depth-mesh', depthSource: 'depth-anything-v2',
    sourceUrl: '/uploads/reconstructions/photo-source.jpg', depthUrl: '/uploads/reconstructions/photo-depth.png',
    width: 1024, height: 768, near: 2, far: 12, fov: 60, mediaBasis: 'image',
    completionUrl: '/uploads/reconstructions/photo-world.json',
  },
};

test('shared photo reconstruction preserves the same assets and depth settings', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  try {
    await client.create('Host');
    await client.selectScene('photo-one', reconstructedScene);
    await delay(0);
    assert.deepEqual(client.snapshot?.scene?.reconstruction, reconstructedScene.reconstruction);
  } finally { client.disconnect(); fake.restore(); }
});

test('received reconstruction rejects remote assets, path traversal and unsafe geometry bounds', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  const errors: string[] = [];
  const unsubscribe = client.subscribe(() => {}, error => errors.push(error.message));
  try {
    await client.create('Host');
    for (const change of [
      { sourceUrl: 'https://example.com/photo.jpg' },
      { sourceUrl: '/uploads/../private.jpg' },
      { depthUrl: '/uploads/%2e%2e/depth.png' },
      { depthUrl: '/uploads/depth.png?token=hidden' },
      { completionUrl: 'https://example.com/world.json' },
      { completionUrl: '/uploads/reconstructions/../private-world.json' },
      { width: 100_000 }, { height: 16.5 }, { near: 12 }, { far: null }, { fov: 180 },
      { depthSource: 'unverified' }, { mediaBasis: 'video' }, { token: 'not-allowed' },
    ]) {
      const scene = { ...reconstructedScene, reconstruction: { ...reconstructedScene.reconstruction, ...change } } as unknown as SceneSpec;
      await client.selectScene('photo-one', scene);
      await delay(0);
      assert.equal(client.snapshot?.scene, null, JSON.stringify(change));
      assert.match(errors.pop() ?? '', /invalid photo reconstruction/, JSON.stringify(change));
    }
  } finally { unsubscribe(); client.disconnect(); fake.restore(); }
});

test('disconnect cancels a pending connection without resurrecting stale identity', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  try {
    const pending = assert.rejects(client.create('Host'), /canceled/);
    client.disconnect();
    await pending;
    await delay(30);
    assert.equal(client.identity, null);
    assert.equal(client.snapshot, null);
  } finally { client.disconnect(); fake.restore(); }
});

test('leave while create waits for views cancels the action and keeps the room closed', async () => {
  const fake = fakeTransport();
  const client = createMultiplayerClient();
  try {
    const pending = assert.rejects(client.create('Host'), /canceled/);
    await delay(10);
    await client.leave();
    await pending;
    await delay(30);
    assert.equal(client.snapshot, null);
    await assert.rejects(client.selectScene('one', null), /Join a room first/);
  } finally { client.disconnect(); fake.restore(); }
});
