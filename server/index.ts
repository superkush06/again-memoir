import 'dotenv/config';
import { createBackend } from './app.js';

const port = Number(process.env.PORT || 3001);
const backend = await createBackend();
backend.server.listen(port, '0.0.0.0', () => console.log(`Memoir API listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  backend.rooms.wss.clients.forEach(client => client.close());
  backend.rooms.wss.close();
  backend.server.close(() => process.exit(0));
});
