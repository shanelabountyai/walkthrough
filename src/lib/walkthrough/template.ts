// Checklist template definitions (Phase 2, docs/walkthrough/PHASE2_PLAN.md). Pure: no I/O.
import { z } from 'zod';
import type { Json } from '@/lib/sync';

const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Keys are 1-48 lowercase letters, digits or dashes, starting with a letter or digit.');
const label = z.string().trim().min(1).max(200);
const base = { key, label, required: z.boolean().default(false) };

export const ITEM_TYPES = ['pass_fail_na', 'number', 'text', 'photo', 'signature'] as const;

export const itemSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('pass_fail_na') }).strict(),
  z
    .object({ ...base, type: z.literal('number'), min: z.number().finite().optional(), max: z.number().finite().optional(), unit: z.string().max(20).optional() })
    .strict()
    .refine((i) => i.min === undefined || i.max === undefined || i.min <= i.max, { message: 'A number item needs min ≤ max.' }),
  z.object({ ...base, type: z.literal('text'), maxLength: z.number().int().min(1).max(10_000).default(2000) }).strict(),
  // "Photo required" is a photo item with required: true (D-18). Upload and storage are Phase 4.
  z.object({ ...base, type: z.literal('photo') }).strict(),
  z.object({ ...base, type: z.literal('signature') }).strict(),
]);

export const definitionSchema = z
  .object({
    sections: z
      .array(z.object({ key, title: label, items: z.array(itemSchema).min(1).max(200) }).strict())
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((d, ctx) => {
    const dup = (keys: string[]) => keys.find((k, i) => keys.indexOf(k) !== i);
    const s = dup(d.sections.map((x) => x.key));
    if (s) ctx.addIssue({ code: 'custom', message: `Section key "${s}" is used twice.` });
    const items = d.sections.flatMap((x) => x.items.map((i) => i.key));
    const i = dup(items);
    if (i) ctx.addIssue({ code: 'custom', message: `Item key "${i}" is used twice; item keys are unique across the template.` });
    if (items.length > 500) ctx.addIssue({ code: 'custom', message: 'A template holds at most 500 items.' });
  });

export type TemplateItem = z.infer<typeof itemSchema>;
export type TemplateDefinition = z.infer<typeof definitionSchema>;

/** The op path an item's answer is written to. */
export const itemPath = (itemKey: string) => `items.${itemKey}`;

/** Parse a definition from the admin's JSON text; `{ error }` reads like a form message. */
export function parseDefinition(text: string): { definition: TemplateDefinition } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'The definition is not valid JSON.' };
  }
  const r = definitionSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return { error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
  }
  return { definition: r.data };
}

/** A content hash reference (photos and signatures upload in Phase 4; an answer only names the blob). */
const HASH = /^sha256:[0-9a-f]{64}$/;

/** Whether `value` is a well-formed answer for `item`. Null means "not answered". Invalid answers are shown, never dropped. */
export function validAnswer(item: TemplateItem, value: Json): boolean {
  if (value === null) return true;
  switch (item.type) {
    case 'pass_fail_na':
      return value === 'pass' || value === 'fail' || value === 'na';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (item.min === undefined || value >= item.min) && (item.max === undefined || value <= item.max);
    case 'text':
      return typeof value === 'string' && value.length <= item.maxLength;
    case 'photo':
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && HASH.test(v));
    case 'signature':
      // A bare image hash (captured before D-41), or `{ image, answers, ops }`: the image bound to the answers signed (signing.ts).
      if (typeof value === 'string') return HASH.test(value);
      return (
        !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'answers,image,ops' &&
        typeof value.image === 'string' && HASH.test(value.image) && typeof value.answers === 'string' && HASH.test(value.answers) &&
        Number.isInteger(value.ops) && (value.ops as number) >= 0
      );
  }
}

/** A small starter template for the "new template" form. */
export const EXAMPLE_DEFINITION: TemplateDefinition = {
  sections: [
    {
      key: 'roof',
      title: 'Roof',
      items: [
        { key: 'roof-condition', label: 'Roof condition', type: 'pass_fail_na', required: true },
        { key: 'roof-photo', label: 'Photo of the roof', type: 'photo', required: true },
      ],
    },
    {
      key: 'hvac',
      title: 'HVAC',
      items: [
        { key: 'supply-temp', label: 'Supply air temperature', type: 'number', min: 40, max: 80, unit: '°F', required: true },
        { key: 'hvac-notes', label: 'Notes', type: 'text', maxLength: 2000, required: false },
        { key: 'customer-signature', label: 'Customer signature', type: 'signature', required: true },
      ],
    },
  ],
};
