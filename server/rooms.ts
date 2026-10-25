import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Participant, RoomSnapshot, SceneSpec } from '../src/types.js';
import type { MemoryStore } from './store.js';
import { allowedOrigin } from './origin.js';

const pose = z.object({ position: z.tuple([z.number().min(-100).max(100), z.number().min(-100).max(100), z.number().min(-100).max(100)]), rotation: z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1)]) });
const person = { name: z.string().trim().min(1).max(30), device: z.enum(['desktop', 'mobile', 'vr']).default('desktop') };
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), ...person }),
  z.object({ type: z.literal('join'), code: z.string().regex(/^[A-Z0-9]{6}$/), ...person }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('select'), memoryId: z.string().max(200) }),
  z.object({ type: z.literal('pose'), pose }),
  z.object({ type: z.literal('device'), device: z.enum(['desktop', 'mobile', 'vr']) }),
]);
type Client = { id: string; room?: string; member?: Participant; window: number; count: number; lastPose: number; alive: boolean };
export function attachRooms(server: Server, store: MemoryStore, scenes: Map<string, SceneSpec>, env: NodeJS.ProcessEnv = process.env) {
  const rooms = new Map<string, RoomSnapshot>();
  const clients = new Map<WebSocket, Client>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url || '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    if (request.headers.origin) {
      if (!allowedOrigin(request.headers.origin, request.headers.host || '', env)) { socket.destroy(); return; }
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  const send = (ws: WebSocket, message: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  function broadcast(code: string) {
    const room = rooms.get(code);
    if (room) for (const [ws, client] of clients) if (client.room === code) send(ws, { type: 'room', room });
  }
  function leave(ws: WebSocket) {
    const client = clients.get(ws);
    if (!client?.room) return;
    const code = client.room; const room = rooms.get(code);
    if (room) {
      room.members = room.members.filter(member => member.id !== client.id);
      if (!room.members.length) rooms.delete(code);
      else { if (room.hostId === client.id) room.hostId = room.members[0].id; broadcast(code); }
    }
    delete client.room; delete client.member;
  }
  wss.on('connection', ws => {
    if (clients.size >= 200) { ws.close(1013, 'Server is full'); return; }
    const client: Client = { id: randomUUID(), window: Date.now(), count: 0, lastPose: 0, alive: true };
    clients.set(ws, client);
    send(ws, { type: 'welcome', clientId: client.id, transport: 'websocket' });
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', raw => {
      try {
        if (Date.now() - client.window >= 1000) { client.window = Date.now(); client.count = 0; }
        if (++client.count > 40) { send(ws, { type: 'error', message: 'Too many updates. Limit movement updates to 20 per second.' }); return; }
        const message = messageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === 'create' || message.type === 'join') {
          let room: RoomSnapshot;
          if (message.type === 'create') {
            if (rooms.size >= 100) throw new Error('Room limit reached.');
            let code: string;
            do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
            room = { roomId: randomUUID(), code, hostId: client.id, memoryId: null, scene: null, members: [] };
            rooms.set(code, room);
          } else {
            const found = rooms.get(message.code);
            if (!found) throw new Error('Room not found. Check the code with your host.');
            if (found.members.length >= 12 && client.room !== found.code) throw new Error('This room is full (12 people).');
            room = found;
          }
          if (client.room !== room.code) leave(ws);
          room.members = room.members.filter(member => member.id !== client.id);
          client.room = room.code;
          client.member = { id: client.id, name: message.name, device: message.device, color: ['#ffb47a', '#8bbcff', '#c5a2ff', '#8ee4bb'][room.members.length % 4] };
          room.members.push(client.member); broadcast(room.code);
        } else if (message.type === 'leave') { leave(ws); send(ws, { type: 'left' }); }
        else {
          const room = client.room ? rooms.get(client.room) : undefined;
          if (!room) throw new Error('Join a room first.');
          if (message.type === 'select') {
            if (room.hostId !== client.id) throw new Error('Only the host can change the shared memory.');
            if (!store.get(message.memoryId)) throw new Error('Memory not found.');
            room.memoryId = message.memoryId; room.scene = scenes.get(message.memoryId) || null; broadcast(room.code);
          } else if (message.type === 'pose') {
            if (Date.now() - client.lastPose < 45) return;
            client.lastPose = Date.now(); client.member!.pose = message.pose;
            for (const [other, member] of clients) if (member.room === room.code && other !== ws) send(other, { type: 'pose', clientId: client.id, pose: message.pose });
          } else if (message.type === 'device') { client.member!.device = message.device; broadcast(room.code); }
        }
      } catch (error) { send(ws, { type: 'error', message: error instanceof z.ZodError || error instanceof SyntaxError ? 'Invalid room message.' : (error as Error).message }); }
    });
    ws.on('close', () => { leave(ws); clients.delete(ws); });
    ws.on('error', () => { leave(ws); clients.delete(ws); });
  });
  const interval = setInterval(() => {
    for (const [ws, client] of clients) { if (!client.alive) { ws.terminate(); continue; } client.alive = false; ws.ping(); }
  }, 30000);
  interval.unref();
  wss.on('close', () => clearInterval(interval));
  return { wss, rooms, updateScene(scene: SceneSpec) { for (const room of rooms.values()) if (room.memoryId === scene.memoryId) { room.scene = scene; broadcast(room.code); } } };
}
