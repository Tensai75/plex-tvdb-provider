import { createProvider } from './provider.mjs';

const api_key = process.env.TVDB_API_KEY?.trim();
if (!api_key) throw new Error('Set TVDB_API_KEY to your TheTVDB v4 API key');

const cacheTtlHours = process.env.TVDB_CACHE_TTL_HOURS?.trim() || '24';
const cacheTtlMs = Number(cacheTtlHours) * 60 * 60 * 1000;
if (!/^\d+$/.test(cacheTtlHours) || !Number.isSafeInteger(cacheTtlMs)) {
  throw new Error('Set TVDB_CACHE_TTL_HOURS to a non-negative whole number (0 disables the cache)');
}

createProvider({
  api_key,
  pin: process.env.TVDB_PIN?.trim(),
  cachePath: '/data/tvdb.sqlite3',
  cacheTtlMs,
}).listen(3000, '0.0.0.0');
