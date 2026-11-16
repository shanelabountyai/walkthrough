// When an inspection is ready to complete (Phase 4). Pure and dependency-free, so the field app can show the same
// checklist offline that the server enforces before it builds the report (src/lib/walkthrough/report.ts).
import { refsIn } from './blobs';
import type { RenderedInspection } from './render';

export type NotReady = { path: string; label: string; why: 'conflict' | 'missing' | 'invalid' | 'uploading' };

/** Every hash the rendered inspection's answers name (photos and signatures, unknown fields included). */
export function reportRefs(r: RenderedInspection): string[] {
  const all = [...r.sections.flatMap((s) => s.items.map((i) => i.value)), ...r.unknownFields.map((u) => u.field.value)];
  return [...new Set(all.flatMap((v) => refsIn(v)))];
}

/**
 * What stops the report: a conflict (WT-03: never pick a value silently), a required item unanswered, an answer that
 * does not fit its item, or a photo or signature the server does not hold yet. Empty: ready.
 */
export function readiness(r: RenderedInspection, complete: ReadonlySet<string>): NotReady[] {
  const out: NotReady[] = [];
  const labels = new Map(r.sections.flatMap((s) => s.items.map((i) => [i.path, i.item.label] as const)));
  for (const path of r.conflicts) out.push({ path, label: labels.get(path) ?? path, why: 'conflict' });
  for (const s of r.sections)
    for (const i of s.items) {
      if (i.item.required && !i.answered) out.push({ path: i.path, label: i.item.label, why: 'missing' });
      else if (!i.valid) out.push({ path: i.path, label: i.item.label, why: 'invalid' });
      if (refsIn(i.value).some((h) => !complete.has(h))) out.push({ path: i.path, label: i.item.label, why: 'uploading' });
    }
  for (const u of r.unknownFields) if (refsIn(u.field.value).some((h) => !complete.has(h))) out.push({ path: u.path, label: u.path, why: 'uploading' });
  return out;
}

export const WHY: Record<NotReady['why'], string> = {
  conflict: 'has conflicting answers to resolve',
  missing: 'is required and not answered',
  invalid: 'has an answer that does not fit the item',
  uploading: 'has a photo or signature still uploading',
};

