const base = (process.env.LIVE_3D_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const health = await fetch(`${base}/api/health`);
if (!health.ok) throw new Error(`3D live check could not reach ${base} (HTTP ${health.status}).`);
const body = await health.json() as { ok?: boolean };
if (body.ok !== true) throw new Error('The app health endpoint did not report ok=true.');
const memoryId = process.env.LIVE_3D_MEMORY_ID;
if (memoryId) {
  const scene = await fetch(`${base}/api/memories/${encodeURIComponent(memoryId)}/scene`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!scene.ok) throw new Error(`Scene endpoint failed (HTTP ${scene.status}).`);
  const result = await scene.json() as { reconstruction?: { kind?: string; depthUrl?: string } };
  if (result.reconstruction?.kind !== 'depth-mesh' || typeof result.reconstruction.depthUrl !== 'string') throw new Error('Scene response did not contain a valid depth mesh contract.');
  console.log(`3D live check passed for memory ${memoryId}.`);
} else {
  console.log('3D live check passed for app health. Set LIVE_3D_MEMORY_ID to exercise a real photo scene.');
}

