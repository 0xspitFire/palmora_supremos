import { mkdir } from 'node:fs/promises';
import { ReadModelClient } from '@mint-bot/web';

// The SSR function serves the site. Vercel still requires its output directory.
await mkdir(new URL('./public/', import.meta.url), { recursive: true });
if (typeof ReadModelClient.prototype.getDashboard !== 'function') throw new Error('Dashboard batch client must be built before packaging');
await import('./api/index.js');
