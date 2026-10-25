import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Memory } from '../src/types.js';
import type { MemoryAI } from './ai.js';
import { isMediaBytes, mimeExtensions } from './http.js';

const cdnDomainsBySource = {
  instagram: ['cdninstagram.com', 'fbcdn.net'],
  linkedin: ['licdn.com'],
  youtube: ['ytimg.com', 'googlevideo.com', 'googleusercontent.com'],
  'google-photos': ['googleusercontent.com'],
} as const;
export function allowedSocialMediaUrl(value: string, source: Memory['source'] = 'instagram') {
  try {
    const url = new URL(value);
    const domains = cdnDomainsBySource[source as keyof typeof cdnDomainsBySource] || cdnDomainsBySource.instagram;
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
export function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  if (family === 6) {
    // Only globally routable IPv6 unicast, excluding transition/mapped ranges.
    const normalized = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2002:') && !normalized.startsWith('2001:0:');
  }
  return false;
}

type Download = { bytes: Buffer; mimeType: string; extension: string };
/** DNS is checked and the socket is pinned to that IP; every redirect is revalidated. */
export async function downloadSocialMedia(value: string, maxBytes = 50 * 1024 * 1024, redirectCount = 0, source: Memory['source'] = 'instagram'): Promise<Download> {
  if (!allowedSocialMediaUrl(value, source)) throw new Error('Media URL is outside supported provider CDNs.');
  if (redirectCount > 3) throw new Error('Too many media redirects.');
  const url = new URL(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Media hostname did not resolve to a public address.');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  const result = await new Promise<Download | { redirect: string }>((resolve, reject) => {
    const req = request({ protocol: 'https:', hostname: address.address, family: address.family, servername: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET', headers: { Host: url.hostname, Accept: 'image/*,video/*', 'User-Agent': 'Memoir/0.1' } }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { response.destroy(); resolve({ redirect: new URL(response.headers.location, url).href }); return; }
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Social media download failed.')); return; }
      const mimeType = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const extension = mimeExtensions[mimeType];
      if (!extension || Number(response.headers['content-length'] || '0') > maxBytes) { response.destroy(); reject(new Error('Unsupported or oversized social media.')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { response.destroy(); reject(new Error('Social media exceeds the size limit.')); } else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (!isMediaBytes(bytes, mimeType)) { reject(new Error('Social media content did not match its format.')); return; }
        resolve({ bytes, mimeType, extension });
      });
    });
    const timeout = setTimeout(() => req.destroy(new Error('Media download timed out.')), 45000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject); req.end();
  });
  return 'redirect' in result ? downloadSocialMedia(result.redirect, maxBytes, redirectCount + 1, source) : result;
}

export async function archiveSocialMemory(original: Memory, uploadsDir: string, ai: MemoryAI, options: { analyze?: boolean } = {}) {
  if (original.url.startsWith('/uploads/')) return { memory: original, warnings: [] as string[] };
  const warnings: string[] = [];
  try {
    const media = await downloadSocialMedia(original.url, 50 * 1024 * 1024, 0, original.source);
    const filename = `${randomUUID()}${media.extension}`;
    await writeFile(path.join(uploadsDir, filename), media.bytes);
    let memory: Memory = { ...original, url: `/uploads/${filename}` };
    if (memory.mediaType === 'image') {
      memory.thumbnailUrl = memory.url;
      if (options.analyze) {
        const result = await ai.describe(memory, media.bytes, media.mimeType);
        if (result.analyzed) {
          memory = { ...memory, description: `${original.description}\n\nVisual description: ${result.memory.description}`, tags: [...new Set([...original.tags, ...result.memory.tags])].slice(0, 30) };
        } else if (ai.configured) warnings.push(`${original.title}: saved locally; image description is unavailable.`);
      }
    } else if (original.thumbnailUrl) {
      try {
        const thumbnail = await downloadSocialMedia(original.thumbnailUrl, 15 * 1024 * 1024, 0, original.source);
        const thumbnailName = `${randomUUID()}${thumbnail.extension}`;
        await writeFile(path.join(uploadsDir, thumbnailName), thumbnail.bytes);
        memory.thumbnailUrl = `/uploads/${thumbnailName}`;
      } catch { warnings.push(`${original.title}: video saved; the preview image is still remote.`); }
    }
    return { memory, warnings };
  } catch {
    return { memory: original, warnings: [`${original.title}: could not archive media from its CDN. The remote URL may expire; upload the original for durable storage.`] };
  }
}
