export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function providerJson(url: string, init: RequestInit = {}, timeout = 25000): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    // Provider bodies may contain user data or credentials; expose only status.
    throw new HttpError(response.status === 401 || response.status === 403 ? 401 : 502, `Provider request failed (${response.status}). Check the integration credentials and permissions.`);
  }
  if (response.status === 204) return {};
  return response.json();
}
export const mimeExtensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};
export function isMediaBytes(buffer: Buffer, mime: string) {
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/gif') return /^GIF8[79]a/.test(buffer.subarray(0, 6).toString());
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return ['video/mp4', 'video/quicktime'].includes(mime) && ['ftyp', 'moov', 'mdat', 'wide'].includes(buffer.subarray(4, 8).toString());
}
