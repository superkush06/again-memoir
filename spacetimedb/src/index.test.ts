import { expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import schema, * as reducers from './index';

const auth = (name: string, connection = 1n) => TestAuth.fromJwtPayload(
  JSON.stringify({ iss: 'memoir-tests', sub: name }), new ConnectionId(connection),
);
const alice = auth('alice');
const bob = auth('bob', 2n);
const stranger = auth('stranger', 3n);
const code = 'ABCDEFGHJKLM';
const makeTest = () => createModuleTestHarness(schema, reducers);
const create = (test: ReturnType<typeof makeTest>, user = alice, roomCode = code) => {
  test.withReducerTx(user, ctx => reducers.createRoom(ctx, { code: roomCode, name: 'Alice', device: 'desktop' }));
};

it('isolates rooms and rejects unauthorized scene changes', () => {
  const test = createModuleTestHarness(schema, reducers);
  create(test);
  expect(reducers.myRoom(test.viewContext(stranger))).toBeUndefined();
  expect(reducers.roomMembers(test.viewContext(stranger))).toEqual([]);
  test.withReducerTx(bob, ctx => reducers.joinRoom(ctx, { code, name: 'Bob', device: 'vr' }));
  expect(reducers.roomMembers(test.viewContext(alice))).toHaveLength(2);
  expect(() => test.withReducerTx(bob, ctx => reducers.selectScene(ctx, { memoryId: 'secret', sceneJson: 'null' }))).toThrow('Only the host');
  test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'memory-one', sceneJson: 'null' }));
  expect(reducers.myRoom(test.viewContext(bob))?.memoryId).toBe('memory-one');
  create(test, stranger, 'NOPQRSTUVWXY');
  expect(reducers.roomMembers(test.viewContext(stranger))).toHaveLength(1);
  expect(reducers.myRoom(test.viewContext(stranger))?.memoryId).toBe('');
});

it('hands host authority to a remaining participant and cleans up empty rooms', () => {
  const test = createModuleTestHarness(schema, reducers);
  create(test);
  test.withReducerTx(bob, ctx => reducers.joinRoom(ctx, { code, name: 'Bob', device: 'mobile' }));
  test.withReducerTx(alice, ctx => reducers.onDisconnect(ctx, {}));
  expect(reducers.roomMembers(test.viewContext(bob))).toHaveLength(1);
  test.withReducerTx(bob, ctx => reducers.selectScene(ctx, { memoryId: 'new-host-memory', sceneJson: 'null' }));
  test.withReducerTx(bob, ctx => reducers.leaveRoom(ctx, {}));
  expect(test.db.room.count()).toBe(0n);
  expect(test.db.member.count()).toBe(0n);
});

it('rejects missing room, malformed data and scene mismatch without partial writes', () => {
  const test = createModuleTestHarness(schema, reducers);
  create(test);
  expect(() => test.withReducerTx(alice, ctx => reducers.joinRoom(ctx, { code: 'NOPQRSTUVWXY', name: 'Alice', device: 'mobile' }))).toThrow('Room not found');
  expect(reducers.myRoom(test.viewContext(alice))?.code).toBe(code);
  expect(() => test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'one', sceneJson: '{"memoryId":"two"}' }))).toThrow('selected memory');
  expect(() => test.withReducerTx(alice, ctx => reducers.updatePose(ctx, { x: Infinity, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }))).toThrow('Invalid pose');
  test.withReducerTx(alice, ctx => reducers.updatePose(ctx, { x: 2, y: 1, z: -3, qx: 0, qy: 0, qz: 0, qw: 1 }));
  expect(reducers.roomMembers(test.viewContext(alice))[0]?.x).toBe(2);
});

it('shares bounded photo reconstruction references and rejects invalid assets atomically', () => {
  const test = makeTest();
  create(test);
  test.withReducerTx(bob, ctx => reducers.joinRoom(ctx, { code, name: 'Bob', device: 'vr' }));
  const reconstruction = {
    version: 1, kind: 'depth-mesh', depthSource: 'depth-anything-v2',
    sourceUrl: '/uploads/reconstructions/photo-source.jpg', depthUrl: '/uploads/reconstructions/photo-depth.png',
    width: 1024, height: 768, near: 2, far: 12, fov: 60, mediaBasis: 'image',
    completionUrl: '/uploads/reconstructions/photo-world.json',
  };
  const scene = { memoryId: 'one', reconstruction };
  const sceneJson = JSON.stringify(scene);
  test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'one', sceneJson }));
  expect(reducers.myRoom(test.viewContext(bob))?.sceneJson).toBe(sceneJson);
  for (const invalid of [
    null,
    { ...reconstruction, sourceUrl: 'https://example.com/photo.jpg' },
    { ...reconstruction, sourceUrl: '/uploads/../private.jpg' },
    { ...reconstruction, depthUrl: '/uploads/depth.png?token=hidden' },
    { ...reconstruction, completionUrl: 'https://example.com/world.json' },
    { ...reconstruction, completionUrl: '/uploads/reconstructions/../secret-world.json' },
    { ...reconstruction, width: 100_000 },
    { ...reconstruction, near: 12 },
    { ...reconstruction, far: null },
    { ...reconstruction, fov: 180 },
    { ...reconstruction, token: 'not-allowed' },
  ]) {
    expect(() => test.withReducerTx(alice, ctx => reducers.selectScene(ctx, {
      memoryId: 'one', sceneJson: JSON.stringify({ ...scene, reconstruction: invalid }),
    }))).toThrow('Invalid photo reconstruction');
    expect(reducers.myRoom(test.viewContext(bob))?.sceneJson).toBe(sceneJson);
  }
  test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'legacy', sceneJson: '{"memoryId":"legacy"}' }));
  expect(reducers.myRoom(test.viewContext(bob))?.memoryId).toBe('legacy');
});

it('shares only the host-selected album memories and rejects widened or malformed manifests', () => {
  const test = makeTest();
  create(test);
  test.withReducerTx(bob, ctx => reducers.joinRoom(ctx, { code, name: 'Bob', device: 'vr' }));
  const albumWorld = {
    albumId: 'album-private', worldId: 'world-album-private', anchorMemoryId: 'anchor', currentMemoryId: 'guest-visible',
    relatedMemoryIds: ['anchor', 'guest-visible', 'private-memory'], sharedMemoryIds: ['anchor', 'guest-visible'],
    geometryNotice: 'Inferred from one photograph; scale and unseen space are approximate.',
  };
  const sceneJson = JSON.stringify({ memoryId: 'anchor', albumWorld });
  test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'anchor', sceneJson }));
  const received = JSON.parse(reducers.myRoom(test.viewContext(bob))!.sceneJson);
  expect(received.albumWorld.sharedMemoryIds).toEqual(['anchor', 'guest-visible']);
  expect(received.albumWorld.sharedMemoryIds).not.toContain('private-memory');
  for (const invalid of [
    { ...albumWorld, sharedMemoryIds: ['anchor', 'not-an-album-member'] },
    { ...albumWorld, currentMemoryId: 'private-memory' },
    { ...albumWorld, sharedMemoryIds: ['guest-visible'] },
    { ...albumWorld, sharedMemoryIds: [] },
  ]) {
    expect(() => test.withReducerTx(alice, ctx => reducers.selectScene(ctx, { memoryId: 'anchor', sceneJson: JSON.stringify({ memoryId: 'anchor', albumWorld: invalid }) }))).toThrow('Invalid album sharing state');
    expect(reducers.myRoom(test.viewContext(bob))?.sceneJson).toBe(sceneJson);
  }
});
