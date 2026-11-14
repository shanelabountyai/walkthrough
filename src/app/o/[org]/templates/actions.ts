'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { Refused } from '@/core/errors';
import { createTemplate, publishVersion } from '@/lib/walkthrough/store';
import { parseDefinition } from '@/lib/walkthrough/template';

// Templates (Phase 2). Managers only (D-16: owner/admin through the template's org.update permission).
const definition = z.string().max(200_000);

export const addTemplate = orgAction('org.update', z.object({ name: z.string().trim().min(1, 'Give the template a name.').max(120), definition }), async (ctx, i) => {
  const parsed = parseDefinition(i.definition);
  if ('error' in parsed) throw new Refused(parsed.error);
  const t = await createTemplate(ctx, i.name, parsed.definition);
  redirect(`/o/${ctx.slug}/templates/${t.id}`);
});

// Every publish is a new immutable version (D-17); inspections already created keep the version they pinned (WT-04).
export const publishTemplateVersion = orgAction('org.update', z.object({ id: ref('checklistTemplate'), definition }), async (ctx, i) => {
  await publishVersion(ctx, i.id, i.definition);
  redirect(`/o/${ctx.slug}/templates/${i.id}`);
});
