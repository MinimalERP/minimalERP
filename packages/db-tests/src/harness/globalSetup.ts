import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

export const PG_USER = 'postgres';
export const PG_PASSWORD = 'postgres';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });

/**
 * Vitest global setup: one real PostgreSQL server for the whole run (no Docker needed).
 * Each test file then creates its own database on it, so files can run in parallel.
 * Durability is switched off — this is a throwaway test cluster, and it makes the suite far faster.
 */
export default async function setup({ provide }: { provide: (key: 'pgPort', value: number) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'minimalerp-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    persistent: false,
    // Match Supabase: UTF-8 database, deterministic byte-order collation.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: [
      '-c', 'max_connections=300',
      '-c', 'fsync=off',
      '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off',
    ],
    onLog: () => undefined,
    onError: () => undefined,
  });

  await server.initialise();
  await server.start();
  provide('pgPort', port);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number;
  }
}
