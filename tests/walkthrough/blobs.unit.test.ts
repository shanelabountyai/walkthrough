import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diskStore } from '@/lib/walkthrough/blob-store';
import { hashOf, isHash, refsIn, sniff, withoutPhoto, withPhoto } from '@/lib/walkthrough/blobs';

// C1 (docs/walkthrough/PHASE4_PLAN.md): answer refs, magic bytes, and the disk adapter's resumable writes.
const h = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('answer refs (D-18)', () => {
  it('a signature is one hash, a photo item a list; anything else names nothing', () => {
    expect(refsIn(h('a'))).toEqual([h('a')]);
    expect(refsIn([h('a'), h('b'), h('a')])).toEqual([h('a'), h('b')]);
    expect(refsIn(['sha256:nothex', 3, null, { x: h('a') }])).toEqual([]);
    expect(refsIn(null)).toEqual([]);
    expect(isHash(h('a').toUpperCase())).toBe(false);
  });

  it('adding and removing photos keeps capture order; removing the last one clears the answer', () => {
    let v = withPhoto(null, h('a'));
    v = withPhoto(v, h('b'));
    expect(withPhoto(v, h('a'))).toEqual([h('a'), h('b')]); // already there: unchanged
    expect(withoutPhoto(v, h('a'))).toEqual([h('b')]);
    expect(withoutPhoto([h('a')], h('a'))).toBeNull();
  });

  it('hashOf is sha256 of the bytes, named the way answers name blobs', async () => {
    expect(await hashOf(new TextEncoder().encode('a'))).toBe(h('a'));
  });
});

describe('sniff', () => {
  it('knows JPEG, PNG, WebP and PDF by their magic numbers, and nothing else', () => {
    expect(sniff(JPEG)).toBe('image/jpeg');
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(sniff(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniff(new TextEncoder().encode('<html><script>'))).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
  });
});

describe('disk blob store', () => {
  const ORG = '00000000-0000-4000-8000-000000000001';
  it('writes at an offset, rewrites a resumed tail, commits, reads, and removes an org', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wt-blobs-'));
    const s = diskStore(root);
    const hash = h('x');
    await s.writeAt(ORG, hash, 0, new Uint8Array([1, 2, 3, 9, 9]));
    await s.writeAt(ORG, hash, 3, new Uint8Array([4, 5])); // a resumed upload rewrites from the server's count
    expect([...(await s.partial(ORG, hash))]).toEqual([1, 2, 3, 4, 5]);
    expect(await s.read(ORG, hash)).toBeNull(); // not a blob until committed
    await s.commit(ORG, hash);
    expect([...(await s.read(ORG, hash))!]).toEqual([1, 2, 3, 4, 5]);
    await s.put(ORG, h('y'), new Uint8Array([7]));
    expect((await readdir(path.join(root, ORG))).sort()).toEqual([hash.slice(7), h('y').slice(7)].sort());
    await s.removeOrg(ORG);
    expect(await s.read(ORG, hash)).toBeNull();
  });

  it('refuses names that could leave its root', async () => {
    const s = diskStore(await mkdtemp(path.join(tmpdir(), 'wt-blobs-')));
    await expect(s.read('../../etc', h('x'))).rejects.toThrow('bad org id');
    await expect(s.read(ORG, 'sha256:../../passwd')).rejects.toThrow('bad blob hash');
  });
});
