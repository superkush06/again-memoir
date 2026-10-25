# Shared memory rooms

The app uses the live SpacetimeDB module in `spacetimedb/`, with generated TypeScript bindings in `src/multiplayer/bindings/` and the browser adapter in `src/multiplayer/index.ts`.

The supplied identity was verified through the logged-in CLI as database **vr-mutliplayer-memoir-naxot**, owned by the current CLI account:

`c200894db85d4878530d2a362d8b892366224a84c4f98cc9876e29d01796bb1f`

Its original module contained only lifecycle reducers. The room module was deployed as an additive migration with `--delete-data=never` on October 24, 2026. No existing data was deleted. [Database dashboard](https://spacetimedb.com/vr-mutliplayer-memoir-naxot).

## Client configuration

The adapter defaults to the verified database. Override for another environment:

```dotenv
VITE_SPACETIMEDB_URL=https://maincloud.spacetimedb.com
VITE_SPACETIMEDB_DATABASE=vr-mutliplayer-memoir-naxot
```

These two identifiers are public configuration. Never put CLI tokens, Gemini keys, Apify tokens, or other service credentials in a `VITE_` variable. The browser receives a separate anonymous SpacetimeDB identity for each client instance; the SDK retains its connection token in memory for reconnects. Laptop, phone, and headset can join independently.

```ts
import { createMultiplayerClient, formatRoomCode } from './multiplayer';

const room = createMultiplayerClient();
const unsubscribe = room.subscribe(snapshot => {
  // snapshot is null outside a room; identity identifies this client.
}, error => console.error(error.message));
await room.create('Alex', 'desktop');
// Or await room.join('ABCD-EFGH-JKLM', 'Alex', 'vr');
// Host only: await room.selectScene(memory.id, scene);
// await room.updatePose({ position: [0, 1.6, 3], rotation: [0, 0, 0, 1] });
// await room.leave();
// unsubscribe(); room.disconnect();
```

`create` / `join` establish a connection lazily. Methods return promises that reject on reducer or connection errors. `subscribe` also reports transport failures. The app does not silently substitute a local room if the configured live service fails. Pose sends are limited to approximately 12 per second per browser, with only one send in flight.

## Access and lifecycle

- The `room` and `member` tables are private. A client can subscribe only to `my_room` and `room_members` views, each filtered using its verified sender identity and room membership.
- New clients receive no room state until a valid code is supplied. The app generates 12 random base32 characters (60 bits) with `crypto.getRandomValues`. Codes are bearer invitations: share them only with intended guests.
- Only a room's host can change its selected memory or scene. Each identity can change only its own pose. The server validates names, devices, pose bounds, quaternion magnitude, scene size, and scene/memory consistency.
- A room holds at most 12 participants. Leaving or disconnecting removes a participant. If the host leaves, authority moves to one remaining participant. The last departure deletes the room and its invitation.
- Network reconnection attempts to rejoin the previous room. If everyone has disconnected and the room has expired, the app reports that the room no longer exists; create a new room.
- Scene interpretation, photo reconstruction descriptors, and selected memory IDs synchronize. The SpacetimeDB module does **not** upload or duplicate image/video files. Source/depth asset paths and geometry bounds are validated using the shared guard; each device builds the same base mesh from those assets. Every device needs access to the same app backend/media library to resolve those IDs. Room privacy does not replace authentication and access control on that separate media backend. See [photo reconstruction](reconstruction.md).

## Development

SpacetimeDB CLI and SDK are pinned to the installed 2.13.0 API. On this Windows workstation the CLI is installed but not on PATH:

```powershell
$spacetimeCli = "$env:LOCALAPPDATA\SpacetimeDB\spacetime.exe"
Set-Location spacetimedb
npm ci
npm run typecheck
npm test
Set-Location ..
& $spacetimeCli build --module-path spacetimedb
& $spacetimeCli generate --lang typescript --module-path spacetimedb --out-dir src/multiplayer/bindings --yes --no-config
```

To deploy an intentional compatible change to the existing database:

```powershell
& $spacetimeCli publish vr-mutliplayer-memoir-naxot --module-path spacetimedb --server maincloud --delete-data=never --yes=remote,migrate --no-config
```

Do not use `--delete-data=always` to bypass a migration failure. Regenerate bindings after schema or reducer changes. To test a local host, start `spacetime start` and point a separate module deployment and client URL at it.

## Verification performed

The module's four automated tests cover room isolation, rejected non-host scene changes, host handoff, empty-room cleanup, pose validation, reconstruction asset validation, and rollback for invalid requests. An opt-in real-network smoke test uses three independent clients and cleans up its temporary rooms:

```powershell
npx tsx src/multiplayer/live-smoke.ts
```

The Maincloud smoke test passed room creation/join, isolated memberships, host authority, reconstruction synchronization and rejection of untrusted asset URLs, pose synchronization, and host handoff. Its temporary rooms are removed in `finally`. The reconstruction validation update was published on October 24, 2026 with `--delete-data=never`; it changed no tables or reducer arguments.

References: [TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/), [sender-filtered views](https://spacetimedb.com/docs/functions/views/), [module testing](https://spacetimedb.com/docs/how-to/unit-testing/), [client bindings](https://spacetimedb.com/docs/clients/codegen/), and [SDK connection lifecycle](https://spacetimedb.com/docs/clients/typescript/).
