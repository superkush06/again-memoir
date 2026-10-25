import { DbConnection } from './bindings';
import type { Participant, Pose, RoomSnapshot, SceneSpec } from '../types';
import { isReconstructionSpec } from '../reconstruction-validation';
import { isAlbumWorldState } from '../album-world-validation';

export interface MultiplayerOptions { uri?: string; database?: string }
type Listener = { snapshot: (room: RoomSnapshot | null) => void; error?: (error: Error) => void };
type Join = { code: string; name: string; device: Participant['device'] };

/** A room-code capability is only sent to SpacetimeDB when creating/joining a room. */
export function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, byte => alphabet[byte & 31]).join('');
}
export const normalizeRoomCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
export const formatRoomCode = (code: string) => normalizeRoomCode(code).match(/.{1,4}/g)?.join('-') ?? '';

function parseScene(json: string): SceneSpec | null {
  if (json.length > 32_000) throw new Error('The host shared a scene that is too large.');
  const scene = JSON.parse(json) as SceneSpec | null;
  if (scene === null) return null;
  if (!scene || typeof scene !== 'object' || typeof scene.memoryId !== 'string' ||
      typeof scene.title !== 'string' || typeof scene.description !== 'string' ||
      !['gallery', 'indoor', 'outdoor', 'beach', 'city', 'forest', 'mountain', 'garden'].includes(scene.environment) ||
      ![scene.skyColor, scene.floorColor, scene.accentColor].every(color => typeof color === 'string' && /^#[a-f\d]{6}$/i.test(color)) ||
      !Number.isFinite(scene.ambientLight) || scene.ambientLight < 0 || scene.ambientLight > 10 ||
      !['gemini', 'fallback'].includes(scene.generatedBy) || !Array.isArray(scene.depthLayers) || scene.depthLayers.length > 20 ||
      !scene.depthLayers.every(layer => layer && [layer.distance, layer.scale, layer.opacity].every(Number.isFinite) && layer.scale > 0 && layer.scale <= 100 && Math.abs(layer.distance) <= 500 && layer.opacity >= 0 && layer.opacity <= 1)) {
    throw new Error('The host shared an invalid scene.');
  }
  if (scene.objects && (!Array.isArray(scene.objects) || scene.objects.length > 150 || !scene.objects.every(object =>
    object && ['tree', 'rock', 'flower', 'lantern', 'building', 'mountain'].includes(object.type) &&
    Array.isArray(object.position) && object.position.length === 3 && object.position.every(value => Number.isFinite(value) && Math.abs(value) <= 500) &&
    (object.scale === undefined || (Number.isFinite(object.scale) && object.scale > 0 && object.scale <= 100)) &&
    (object.color === undefined || /^#[a-f\d]{6}$/i.test(object.color))))) {
    throw new Error('The host shared invalid scene objects.');
  }
  if (scene.reconstruction !== undefined && !isReconstructionSpec(scene.reconstruction)) {
    throw new Error('The host shared an invalid photo reconstruction.');
  }
  if (scene.albumWorld !== undefined && !isAlbumWorldState(scene.albumWorld)) {
    throw new Error('The host shared invalid album navigation.');
  }
  return scene;
}

export class MultiplayerClient {
  readonly transport = 'spacetimedb';
  private connection: DbConnection | null = null;
  private connecting: Promise<DbConnection> | null = null;
  private currentIdentity: string | null = null;
  private currentSnapshot: RoomSnapshot | null = null;
  private listeners = new Set<Listener>();
  private lastJoin: Join | null = null;
  private connectionEpoch = 0;
  private roomActionVersion = 0;
  private cancelConnection: ((error: Error) => void) | null = null;
  private roomWaiters = new Set<(error: Error) => void>();
  private cachedSceneJson: string | null = null;
  private cachedScene: SceneSpec | null = null;
  private queuedSnapshot = false;
  private lastPoseAt = 0;
  private poseInFlight = false;
  private readonly uri: string;
  private readonly database: string;

  constructor(options: MultiplayerOptions = {}) {
    this.uri = options.uri ?? import.meta.env?.VITE_SPACETIMEDB_URL ?? 'https://maincloud.spacetimedb.com';
    this.database = options.database ?? import.meta.env?.VITE_SPACETIMEDB_DATABASE ?? 'vr-mutliplayer-memoir-naxot';
  }
  get identity() { return this.currentIdentity; }
  get snapshot() { return this.currentSnapshot; }

  subscribe(onSnapshot: Listener['snapshot'], onError?: Listener['error']) {
    const listener = { snapshot: onSnapshot, error: onError };
    this.listeners.add(listener);
    onSnapshot(this.currentSnapshot);
    return () => { this.listeners.delete(listener); };
  }
  private report(error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.listeners) listener.error?.(normalized);
  }
  private emit(snapshot: RoomSnapshot | null) {
    this.currentSnapshot = snapshot;
    for (const listener of this.listeners) listener.snapshot(snapshot);
  }
  private queueSnapshot = () => {
    if (this.queuedSnapshot) return;
    this.queuedSnapshot = true;
    queueMicrotask(() => {
      this.queuedSnapshot = false;
      const conn = this.connection;
      if (!conn) return;
      const room = [...conn.db.myRoom.iter()][0];
      if (!room) { this.emit(null); return; }
      // Pose updates do not change content: retain the same scene object for React.
      if (room.sceneJson !== this.cachedSceneJson) {
        this.cachedSceneJson = room.sceneJson;
        this.cachedScene = null;
        try { this.cachedScene = parseScene(room.sceneJson); } catch (error) { this.report(error); }
      }
      const albumWorld = this.cachedScene?.albumWorld;
      this.emit({
        roomId: room.code, code: room.code, hostId: room.host.toHexString(),
        memoryId: room.memoryId || null, scene: this.cachedScene,
        ...(albumWorld ? { albumId: albumWorld.albumId, worldId: albumWorld.worldId, relatedMemoryIds: albumWorld.relatedMemoryIds, sharedMemoryIds: albumWorld.sharedMemoryIds } : {}),
        members: [...conn.db.roomMembers.iter()].map((person): Participant => ({
          id: person.identity.toHexString(), name: person.name, color: person.color,
          device: person.device as Participant['device'],
          pose: { position: [person.x, person.y, person.z], rotation: [person.qx, person.qy, person.qz, person.qw] },
        })).sort((a, b) => a.id.localeCompare(b.id)),
      });
    });
  };
  private connect(): Promise<DbConnection> {
    if (this.connecting) return this.connecting;
    if (this.connection?.isActive) return Promise.resolve(this.connection);
    // An explicit new room action replaces a disconnected/reconnecting transport.
    if (this.connection) this.disconnect();
    const epoch = ++this.connectionEpoch;
    const pending = new Promise<DbConnection>((resolve, reject) => {
      let ready = false;
      const fail = (error: Error) => {
        if (epoch !== this.connectionEpoch) return;
        ++this.connectionEpoch;
        clearTimeout(timeout);
        this.cancelConnection = null;
        this.connection?.disconnect();
        this.connection = null;
        this.currentIdentity = null;
        this.lastJoin = null;
        this.emit(null);
        reject(error);
        this.report(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error('Could not connect to the shared room service. Check your connection and try again.'));
      }, 15_000);
      this.cancelConnection = error => { clearTimeout(timeout); reject(error); };
      try { this.connection = DbConnection.builder()
        .withUri(this.uri).withDatabaseName(this.database)
        .withAutomaticReconnect()
        .onConnect((conn, identity) => {
          if (epoch !== this.connectionEpoch) return;
          this.currentIdentity = identity.toHexString();
          conn.db.myRoom.onInsert(this.queueSnapshot);
          conn.db.myRoom.onDelete(this.queueSnapshot);
          conn.db.myRoom.onUpdate(this.queueSnapshot);
          conn.db.roomMembers.onInsert(this.queueSnapshot);
          conn.db.roomMembers.onDelete(this.queueSnapshot);
          conn.subscriptionBuilder()
            .onApplied(() => {
              if (epoch !== this.connectionEpoch) return;
              clearTimeout(timeout); ready = true; this.cancelConnection = null;
              this.queueSnapshot(); resolve(conn);
            })
            .onError(ctx => {
              const error = ctx.event instanceof Error ? ctx.event : new Error('The room subscription failed.');
              fail(error);
            })
            .subscribe(['SELECT * FROM my_room', 'SELECT * FROM room_members']);
        })
        .onAutomaticReconnect((conn, identity) => {
          if (epoch !== this.connectionEpoch) return;
          this.currentIdentity = identity.toHexString();
          if (this.lastJoin) void conn.reducers.joinRoom(this.lastJoin).catch(error => {
            if (epoch !== this.connectionEpoch) return;
            this.lastJoin = null; this.emit(null); this.report(error);
          });
        })
        .onConnectError((_ctx, error) => {
          if (epoch !== this.connectionEpoch) return;
          if (!ready) fail(error); else this.report(error);
        })
        .onDisconnect((_ctx, error, nextAttempt) => {
          if (epoch !== this.connectionEpoch) return;
          if (!ready) { fail(error ?? new Error('Disconnected before the room service was ready.')); return; }
          this.emit(null);
          this.report(error ?? new Error(nextAttempt ? 'Connection lost. Reconnecting to your room…' : 'Disconnected from the room.'));
        })
        .build(); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.connecting = pending;
    const clear = () => { if (this.connecting === pending) this.connecting = null; };
    pending.then(clear, clear);
    return pending;
  }
  private waitForRoom(code: string) {
    const matches = (snapshot: RoomSnapshot | null) => snapshot?.code === code && snapshot.members.some(person => person.id === this.identity);
    if (matches(this.currentSnapshot)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout); this.listeners.delete(listener); this.roomWaiters.delete(cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = (error: Error) => finish(error);
      const listener: Listener = { snapshot: snapshot => { if (matches(snapshot)) finish(); }, error: cancel };
      const timeout = setTimeout(() => finish(new Error('The room was created or joined, but its live state has not arrived. Please reconnect.')), 10_000);
      this.listeners.add(listener);
      this.roomWaiters.add(cancel);
    });
  }
  async create(name: string, device: Participant['device'] = 'desktop') {
    const connecting = this.connect();
    const operation = ++this.roomActionVersion;
    const conn = await connecting;
    if (operation !== this.roomActionVersion || conn !== this.connection) throw new Error('Room action was canceled.');
    const args: Join = { code: generateRoomCode(), name, device };
    await conn.reducers.createRoom(args);
    if (operation !== this.roomActionVersion || conn !== this.connection) throw new Error('Room action was canceled.');
    this.lastJoin = args;
    this.queueSnapshot();
    await this.waitForRoom(args.code);
  }
  async join(code: string, name: string, device: Participant['device'] = 'desktop') {
    const connecting = this.connect();
    const operation = ++this.roomActionVersion;
    const conn = await connecting;
    if (operation !== this.roomActionVersion || conn !== this.connection) throw new Error('Room action was canceled.');
    const args = { code: normalizeRoomCode(code), name, device };
    await conn.reducers.joinRoom(args);
    if (operation !== this.roomActionVersion || conn !== this.connection) throw new Error('Room action was canceled.');
    this.lastJoin = args;
    this.queueSnapshot();
    await this.waitForRoom(args.code);
  }
  async selectScene(memoryId: string, scene: SceneSpec | null) {
    // Membership is established by the acknowledged reducer, independently of view delivery.
    if (!this.connection?.isActive || !this.lastJoin) throw new Error('Join a room first.');
    await this.connection.reducers.selectScene({ memoryId, sceneJson: JSON.stringify(scene) });
  }
  async updatePose(pose: Pose) {
    if (!this.connection?.isActive || !this.currentSnapshot || this.poseInFlight || Date.now() - this.lastPoseAt < 80) return;
    this.lastPoseAt = Date.now();
    this.poseInFlight = true;
    try {
      const [x, y, z] = pose.position;
      const [qx, qy, qz, qw] = pose.rotation;
      await this.connection.reducers.updatePose({ x, y, z, qx, qy, qz, qw });
    } finally { this.poseInFlight = false; }
  }
  async leave() {
    const operation = ++this.roomActionVersion;
    for (const cancel of this.roomWaiters) cancel(new Error('Room action was canceled.'));
    this.lastJoin = null;
    if (this.connection?.isActive) await this.connection.reducers.leaveRoom({});
    if (operation === this.roomActionVersion) this.emit(null);
  }
  disconnect() {
    ++this.connectionEpoch;
    ++this.roomActionVersion;
    const canceled = new Error('Room connection was canceled.');
    this.cancelConnection?.(canceled);
    this.cancelConnection = null;
    for (const cancel of this.roomWaiters) cancel(canceled);
    this.lastJoin = null;
    this.connection?.disconnect();
    this.connection = null;
    this.connecting = null;
    this.currentIdentity = null;
    this.cachedSceneJson = null;
    this.cachedScene = null;
    this.emit(null);
  }
}

export const createMultiplayerClient = (options?: MultiplayerOptions) => new MultiplayerClient(options);
