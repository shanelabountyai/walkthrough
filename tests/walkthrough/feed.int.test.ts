import { describe, expect, it } from 'vitest';
import { GET } from '@/app/o/[org]/inspections/feed/route';
import { APP, world } from './helpers';

// Phase 3's feed (the field app's list) honours WT-05: assigned inspections only, all of them for a manager.
const feed = async (slug: string) => {
  const res = await GET(new Request(`${APP}/o/${slug}/inspections/feed`), { params: Promise.resolve({ org: slug }) });
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
};

describe('inspection feed (WT-05)', () => {
  it('lists the assignee\'s inspection for them and a manager, nothing for another technician, never cached', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const a = await feed(w.slug);
    expect(a).toMatchObject({ status: 200, cache: 'no-store', body: { userId: w.techA.id, inspections: [{ id: w.inspectionId, title: 'Smith house', templateVersion: 1, conflicts: 0 }] } });
    await w.as(w.techB.id);
    expect((await feed(w.slug)).body).toEqual({ userId: w.techB.id, inspections: [] });
    await w.as(w.manager.id);
    expect((await feed(w.slug)).body.inspections.map((i: { id: string }) => i.id)).toEqual([w.inspectionId]);
  });
});
