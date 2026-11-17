// Where blob bytes live (Phase 4). D-03: object storage behind an interface, a local disk adapter in dev. D-30: only
// the disk adapter exists so far; a deployed environment refuses until an object-storage adapter is added, rather
// than writing to a serverless function's throwaway disk. The database row (StoredBlob) is the source of truth for
// how many bytes an upload has; the store only holds them.
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/core/env';
import { HASH_RE } from './blobs';

export interface BlobStore {
  /** Write `bytes` at `offset` of the partial upload, dropping anything after it (a resumed upload rewrites the tail). */
  writeAt(orgId: string, hash: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** The partial upload so far (for the final hash check). */
  partial(orgId: string, hash: string): Promise<Uint8Array>;
  /** The partial upload becomes the blob. */
  commit(orgId: string, hash: string): Promise<void>;
  /** Write a whole blob at once (server-made blobs: reports). */
  put(orgId: string, hash: string, bytes: Uint8Array): Promise<void>;
  read(orgId: string, hash: string): Promise<Uint8Array | null>;
  /** Drop a partial upload (a failed hash check). */
  discard(orgId: string, hash: string): Promise<void>;
  /** Everything of one org (org deletion, src/app/org-hooks.ts). */
  removeOrg(orgId: string): Promise<void>;
}

export class BlobStoreUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Files under `<root>/<orgId>/<hex>` and `<hex>.part`. Names are checked, so nothing escapes the root. */
export function diskStore(root: string): BlobStore {
  const dir = (orgId: string) => {
    if (!UUID.test(orgId)) throw new Error('bad org id');
    return path.join(root, orgId);
  };
  const file = (orgId: string, hash: string, part = false) => {
    if (!HASH_RE.test(hash)) throw new Error('bad blob hash');
    return path.join(dir(orgId), `${hash.slice(7)}${part ? '.part' : ''}`);
  };
  const orNull = async <T>(p: Promise<T>) => p.catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  return {
    async writeAt(orgId, hash, offset, bytes) {
      await mkdir(dir(orgId), { recursive: true });
      const fh = await open(file(orgId, hash, true), 'a+');
      try {
        await fh.truncate(offset);
        await fh.write(bytes, 0, bytes.length, offset);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    async partial(orgId, hash) {
      return new Uint8Array((await orNull(readFile(file(orgId, hash, true)))) ?? new Uint8Array());
    },
    async commit(orgId, hash) {
      await rename(file(orgId, hash, true), file(orgId, hash));
    },
    async put(orgId, hash, bytes) {
      await mkdir(dir(orgId), { recursive: true });
      const tmp = `${file(orgId, hash)}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file(orgId, hash));
    },
    async read(orgId, hash) {
      const b = await orNull(readFile(file(orgId, hash)));
      return b ? new Uint8Array(b) : null;
    },
    async discard(orgId, hash) {
      await rm(file(orgId, hash, true), { force: true });
    },
    async removeOrg(orgId) {
      await rm(dir(orgId), { recursive: true, force: true });
    },
  };
}

/** The local disk root (gitignored `uploads/`). */
export const BLOB_ROOT = path.join(process.cwd(), 'uploads', 'blobs');

let override: BlobStore | null = null;
/** Tests swap the store (e.g. a temp directory). */
export function setBlobStore(s: BlobStore | null) {
  override = s;
}

/** The store for this environment: the disk adapter locally and in CI; refused when deployed (D-30). */
export function blobStore(): BlobStore {
  if (override) return override;
  if (env.VERCEL_ENV) throw new BlobStoreUnavailable('No object-storage adapter is configured for a deployed environment (D-30).');
  return diskStore(BLOB_ROOT);
}
