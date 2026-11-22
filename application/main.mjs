import { createProvider } from './provider.mjs';

const api_key = process.env.TVDB_API_KEY?.trim();
if (!api_key) throw new Error('Set TVDB_API_KEY to your TheTVDB v4 API key');

createProvider({
  api_key,
  pin: process.env.TVDB_PIN?.trim(),
  cachePath: '/data/tvdb.sqlite3',
}).listen(3000, '0.0.0.0');
