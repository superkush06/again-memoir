/** Vite may proxy localhost requests through a 127.0.0.1 upstream. */
export function allowedOrigin(origin: string, requestHost: string, env: NodeJS.ProcessEnv) {
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (env.APP_ORIGIN && parsed.origin === new URL(env.APP_ORIGIN).origin) return true;
    const host = new URL(`http://${requestHost}`).hostname;
    if (parsed.hostname === host) return true;
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    return env.NODE_ENV !== 'production' && loopback.has(parsed.hostname) && loopback.has(host);
  } catch { return false; }
}
