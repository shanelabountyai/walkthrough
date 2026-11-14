import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { addTemplate, publishTemplateVersion } from '@/app/o/[org]/templates/actions';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';
import { NavSignal } from '../helpers/next';
import { world } from './helpers';

// A3: an admin builds templates; publishing creates version n+1; a published version can never change.
const nav = async (p: Promise<unknown>) => {
  try {
    return { result: await p };
  } catch (e) {
    if (e instanceof NavSignal) return { nav: e };
    throw e;
  }
};

describe('templates (A3)', () => {
  it('a manager creates a template (version 1) and publishes version 2; earlier versions are untouched', async () => {
    const w = await world();
    await w.as(w.manager.id);
    const created = await nav(addTemplate(w.slug, { name: 'Attic', definition: JSON.stringify(EXAMPLE_DEFINITION) }));
    expect(created.nav?.to).toMatch(new RegExp(`^/o/${w.slug}/templates/`));
    const t = await db.checklistTemplate.findFirstOrThrow({ where: { name: 'Attic' } });
    const v2 = { sections: [{ key: 'attic', title: 'Attic', items: [{ key: 'insulation', label: 'Insulation depth', type: 'number', min: 0, max: 30, unit: 'in' }] }] };
    await nav(publishTemplateVersion(w.slug, { id: t.id, definition: JSON.stringify(v2) }));
    const versions = await db.templateVersion.findMany({ where: { templateId: t.id }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.definition).toEqual(JSON.parse(JSON.stringify(EXAMPLE_DEFINITION)));
    expect((versions[1]!.definition as { sections: { key: string }[] }).sections[0]!.key).toBe('attic');
    const events = await db.auditEvent.findMany({ where: { targetId: t.id }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['template.created', 'template.version_published']);
  });

  it('refuses an invalid definition with a form message and stores nothing', async () => {
    const w = await world();
    await w.as(w.manager.id);
    const before = await db.templateVersion.count();
    expect(await addTemplate(w.slug, { name: 'Bad', definition: '{"sections":[]}' })).toEqual({ error: expect.stringContaining('sections') });
    expect(await publishTemplateVersion(w.slug, { id: w.template.id, definition: 'nope' })).toEqual({ error: 'The definition is not valid JSON.' });
    expect(await db.templateVersion.count()).toBe(before);
  });

  it('a technician cannot create or publish templates', async () => {
    const w = await world();
    await w.as(w.techA.id);
    await expect(addTemplate(w.slug, { name: 'X', definition: JSON.stringify(EXAMPLE_DEFINITION) })).rejects.toThrow('Missing permission: org.update');
    await expect(publishTemplateVersion(w.slug, { id: w.template.id, definition: JSON.stringify(EXAMPLE_DEFINITION) })).rejects.toThrow('Missing permission');
  });

  it('a published version cannot be updated in the database (WT-04 trigger)', async () => {
    const w = await world();
    await expect(db.$executeRaw`UPDATE "TemplateVersion" SET definition = '{}'::jsonb WHERE "templateId" = ${w.template.id}::uuid`).rejects.toThrow(/immutable/);
  });
});
