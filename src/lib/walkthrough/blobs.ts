// Photo, signature and report blobs (Phase 4, docs/walkthrough/PHASE4_PLAN.md). Pure: no I/O, so the device and the
// server share these rules. A blob is named by its content hash, `sha256:<64 hex>` (D-18), which is also what an
// answer to a photo or signature item holds.
import type { FieldState, Json } from '@/lib/sync';

export const HASH_RE = /^sha256:[0-9a-f]{64}$/;
export const isHash = (s: unknown): s is string => typeof s === 'string' && HASH_RE.test(s);

/** The largest blob accepted (a phone photo is downscaled on the device first, so this is generous). */
export const MAX_BLOB_BYTES = 15 * 1024 * 1024;
/** Upload chunk size the device uses; the server accepts any chunk up to MAX_CHUNK_BYTES. */
export const CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;

/** Types a device may upload. Reports (application/pdf) are written by the server only. */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];
export const isUploadType = (t: unknown): t is UploadType => typeof t === 'string' && (UPLOAD_TYPES as readonly string[]).includes(t);

/**
 * Every blob hash an answer names, in order, without duplicates: a signature is one hash (bare, or the `image` of a
 * bound signature, D-41), a photo item a list.
 */
export function refsIn(value: Json): string[] {
  const out: string[] = [];
  const add = (v: Json) => {
    if (isHash(v) && !out.includes(v)) out.push(v);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (value && typeof value === 'object' && 'image' in value) add(value.image as Json);
  else add(value);
  return out;
}

/** The content type the bytes really are, from their magic numbers; null when it is none of the known kinds. */
export function sniff(b: Uint8Array): UploadType | 'application/pdf' | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

/** `sha256:<hex>` of some bytes, with Web Crypto (browser and Node 22 alike). */
export async function hashOf(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return `sha256:${[...d].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** A photo answer with one hash added (kept in capture order) or removed. Null when no photo is left. */
export function withPhoto(current: Json, hash: string): Json {
  const list = refsIn(current);
  return list.includes(hash) ? list : [...list, hash];
}
export function withoutPhoto(current: Json, hash: string): Json {
  const list = refsIn(current).filter((h) => h !== hash);
  return list.length ? list : null;
}

/**
 * The photo list a device builds its next answer from (D-39). Normally the displayed value. While the item is in
 * conflict (D-36: two devices added photos concurrently), every competing value counts: the union of all head lists,
 * oldest head first, each list in its own order, without duplicates. A new add or remove then supersedes every head
 * (the op's `prev`) without silently dropping a photo another device took (WT-03).
 */
export function photoBase(field: Pick<FieldState, 'value' | 'heads' | 'conflict'> | undefined): Json {
  if (!field) return null;
  if (!field.conflict || field.heads.length < 2) return field.value;
  const out: string[] = [];
  for (const h of field.heads) for (const r of refsIn(h.value)) if (!out.includes(r)) out.push(r);
  return out.length ? out : null;
}
