import { describe, expect, it } from 'vitest';
import Templates from '@/app/o/[org]/templates/page';
import TemplatePage from '@/app/o/[org]/templates/[id]/page';
import { ManagersOnly } from '@/app/o/[org]/templates/managers-only';
import { textOf, world } from './helpers';

// Design pass 2026-11-18 (PRD DX-06): template pages stay managers-only (D-16), and a technician who reaches one is
// told so in plain words instead of the error page. The refusal renders nothing about the org's templates.
describe('DX-06: template pages refuse technicians in plain words', () => {
  it('a technician gets the managers-only page on the list and on a template; a manager gets the templates', async () => {
    const w = await world();
    const t = w.template;
    await w.as(w.techA.id);
    for (const page of [await Templates({ params: Promise.resolve({ org: w.slug }) }), await TemplatePage({ params: Promise.resolve({ org: w.slug, id: t.id }) })]) {
      expect((page as { type: unknown }).type).toBe(ManagersOnly);
      expect(textOf(page)).not.toContain(t.name);
    }
    await w.as(w.manager.id);
    expect(textOf(await Templates({ params: Promise.resolve({ org: w.slug }) }))).toContain(t.name);
  });
});
