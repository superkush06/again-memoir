import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { isReconstructionSpec } from '../../src/reconstruction-validation';
import { isAlbumWorldState } from '../../src/album-world-validation';

// Private base tables: clients only receive the room they have joined via views.
const room = table({ name: 'room', public: false }, {
  code: t.string().primaryKey(),
  host: t.identity(),
  memoryId: t.string(),
  sceneJson: t.string(),
});
const member = table({ name: 'member', public: false }, {
  identity: t.identity().primaryKey(),
  connection: t.string(),
  roomCode: t.string().index('btree'),
  name: t.string(),
  device: t.string(),
  color: t.string(),
  x: t.f64(), y: t.f64(), z: t.f64(),
  qx: t.f64(), qy: t.f64(), qz: t.f64(), qw: t.f64(),
});

const spacetimedb = schema({ room, member });
export default spacetimedb;
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
const COLORS = ['#c86642', '#728b63', '#596f92', '#b29257', '#9b718f', '#4f8f94'];

function checkedName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 32) throw new SenderError('Choose a name between 1 and 32 characters.');
  return trimmed;
}
function checkedDevice(device: string) {
  if (!['desktop', 'mobile', 'vr'].includes(device)) throw new SenderError('Unsupported device.');
  return device;
}
function checkedCode(code: string) {
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z2-9]{12}$/.test(normalized)) throw new SenderError('Enter the 12-character room code.');
  return normalized;
}
function removeMember(ctx: Ctx) {
  const current = ctx.db.member.identity.find(ctx.sender);
  if (!current) return;
  ctx.db.member.identity.delete(ctx.sender);
  const currentRoom = ctx.db.room.code.find(current.roomCode);
  if (!currentRoom) return;
  const remaining = [...ctx.db.member.roomCode.filter(current.roomCode)];
  if (!remaining.length) ctx.db.room.code.delete(current.roomCode);
  else if (currentRoom.host.isEqual(ctx.sender)) {
    // Deterministic handoff: the remaining participant with the lowest identity.
    remaining.sort((a, b) => a.identity.toHexString().localeCompare(b.identity.toHexString()));
    ctx.db.room.code.update({ ...currentRoom, host: remaining[0].identity });
  }
}
function insertMember(ctx: Ctx, roomCode: string, name: string, device: string) {
  const peers = [...ctx.db.member.roomCode.filter(roomCode)];
  if (peers.length >= 12) throw new SenderError('This room is full (12 people).');
  ctx.db.member.insert({
    identity: ctx.sender, connection: ctx.connectionId?.toHexString() ?? '',
    roomCode, name, device, color: COLORS[peers.length % COLORS.length],
    x: peers.length * 0.6, y: 1.6, z: 3, qx: 0, qy: 0, qz: 0, qw: 1,
  });
}

export const init = spacetimedb.init(() => {});
export const onConnect = spacetimedb.clientConnected(() => {});
export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const current = ctx.db.member.identity.find(ctx.sender);
  if (current?.connection === ctx.connectionId?.toHexString()) removeMember(ctx);
});

export const createRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), device: t.string() },
  (ctx, args) => {
    const code = checkedCode(args.code);
    const name = checkedName(args.name);
    const device = checkedDevice(args.device);
    if (ctx.db.room.code.find(code)) throw new SenderError('Room code already exists. Please try again.');
    removeMember(ctx);
    ctx.db.room.insert({ code, host: ctx.sender, memoryId: '', sceneJson: 'null' });
    insertMember(ctx, code, name, device);
  },
);
export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), device: t.string() },
  (ctx, args) => {
    const code = checkedCode(args.code);
    const name = checkedName(args.name);
    const device = checkedDevice(args.device);
    if (!ctx.db.room.code.find(code)) throw new SenderError('Room not found. Check the code and ask the host to keep the room open.');
    const current = ctx.db.member.identity.find(ctx.sender);
    if (current?.roomCode === code) {
      ctx.db.member.identity.update({ ...current, name, device, connection: ctx.connectionId?.toHexString() ?? '' });
      return;
    }
    removeMember(ctx);
    insertMember(ctx, code, name, device);
  },
);
export const leaveRoom = spacetimedb.reducer(ctx => removeMember(ctx));

export const selectScene = spacetimedb.reducer(
  { memoryId: t.string(), sceneJson: t.string() },
  (ctx, { memoryId, sceneJson }) => {
    const membership = ctx.db.member.identity.find(ctx.sender);
    const currentRoom = membership && ctx.db.room.code.find(membership.roomCode);
    if (!currentRoom) throw new SenderError('Join a room first.');
    if (!currentRoom.host.isEqual(ctx.sender)) throw new SenderError('Only the host can change the shared memory.');
    if (memoryId.length > 256 || sceneJson.length > 32_000) throw new SenderError('Memory or scene is too large.');
    let scene: unknown;
    try { scene = JSON.parse(sceneJson); } catch { throw new SenderError('Invalid scene.'); }
    if (scene !== null) {
      if (typeof scene !== 'object' || Array.isArray(scene) || !('memoryId' in scene) || scene.memoryId !== memoryId) {
        throw new SenderError('Scene must describe the selected memory.');
      }
      if ('reconstruction' in scene && !isReconstructionSpec(scene.reconstruction)) {
        throw new SenderError('Invalid photo reconstruction.');
      }
      if ('albumWorld' in scene && scene.albumWorld !== undefined && !isAlbumWorldState(scene.albumWorld)) {
        throw new SenderError('Invalid album sharing state.');
      }
    }
    ctx.db.room.code.update({ ...currentRoom, memoryId, sceneJson });
  },
);
export const updatePose = spacetimedb.reducer(
  { x: t.f64(), y: t.f64(), z: t.f64(), qx: t.f64(), qy: t.f64(), qz: t.f64(), qw: t.f64() },
  (ctx, pose) => {
    const current = ctx.db.member.identity.find(ctx.sender);
    if (!current) throw new SenderError('Join a room first.');
    if (!Object.values(pose).every(Number.isFinite)) throw new SenderError('Invalid pose.');
    if ([pose.x, pose.y, pose.z].some(value => Math.abs(value) > 500)) throw new SenderError('Position is out of bounds.');
    const magnitude = Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw);
    if (magnitude < 0.01 || magnitude > 2) throw new SenderError('Invalid rotation.');
    ctx.db.member.identity.update({ ...current, ...pose,
      qx: pose.qx / magnitude, qy: pose.qy / magnitude, qz: pose.qz / magnitude, qw: pose.qw / magnitude });
  },
);

export const myRoom = spacetimedb.view(
  { name: 'my_room', public: true }, t.option(room.rowType), ctx => {
    const current = ctx.db.member.identity.find(ctx.sender);
    return current ? ctx.db.room.code.find(current.roomCode) ?? undefined : undefined;
  },
);
// Omit connection identifiers from the public projection.
const participant = t.row('Participant', {
  identity: t.identity(), name: t.string(), device: t.string(), color: t.string(),
  x: t.f64(), y: t.f64(), z: t.f64(), qx: t.f64(), qy: t.f64(), qz: t.f64(), qw: t.f64(),
});
export const roomMembers = spacetimedb.view(
  { name: 'room_members', public: true }, t.array(participant), ctx => {
    const current = ctx.db.member.identity.find(ctx.sender);
    if (!current) return [];
    return [...ctx.db.member.roomCode.filter(current.roomCode)].map(({ connection: _connection, roomCode: _code, ...person }) => person);
  },
);
