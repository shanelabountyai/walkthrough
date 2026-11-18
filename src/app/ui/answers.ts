// How an answer reads on screen (design pass 2026-11-18): every status is a word, then a glyph, then a colour, never
// colour alone (docs/design/*.dc.html). Pure: the office pages and the field app both use it; nothing here decides
// anything — validity and conflicts come from render.ts, unchanged.
import type { Json } from '@/lib/sync';
import { refsIn } from '@/lib/walkthrough/blobs';
import type { RenderedItem } from '@/lib/walkthrough/render';
import type { TemplateItem } from '@/lib/walkthrough/template';

export type Tone = 'pass' | 'fail' | 'na' | 'warn' | 'wait' | 'ok' | 'open';
export interface Shown {
  word: string;
  /** Decorative: always rendered aria-hidden next to the word. */
  glyph: string;
  tone: Tone;
}

const PFN: Record<string, Shown> = {
  pass: { word: 'Pass', glyph: '✓', tone: 'pass' },
  fail: { word: 'Fail', glyph: '✕', tone: 'fail' },
  na: { word: 'Not applicable', glyph: '–', tone: 'na' },
};

/** The allowed range of a number item in words, e.g. "allowed 0–100 ppm"; empty when it has no bounds. */
export function rangeText(item: TemplateItem): string {
  if (item.type !== 'number') return '';
  const unit = item.unit ? ` ${item.unit}` : '';
  if (item.min !== undefined && item.max !== undefined) return `allowed ${item.min}–${item.max}${unit}`;
  if (item.min !== undefined) return `at least ${item.min}${unit}`;
  if (item.max !== undefined) return `at most ${item.max}${unit}`;
  return item.unit ? `in ${item.unit}` : '';
}

/** Why a number is out of range, in plain words; null when it fits (or is not a number item / not a number). */
export function rangeProblem(item: TemplateItem, value: Json): string | null {
  if (item.type !== 'number' || typeof value !== 'number') return null;
  if (item.max !== undefined && value > item.max) return `${value} is above the allowed range (${rangeText(item).replace(/^allowed |^at most /, '')}).`;
  if (item.min !== undefined && value < item.min) return `${value} is below the allowed range (${rangeText(item).replace(/^allowed |^at least /, '')}).`;
  return null;
}

/** One value as text: a conflicting head, or an answer. */
export function valueText(item: TemplateItem, v: Json): string {
  if (v === null) return 'No answer';
  switch (item.type) {
    case 'pass_fail_na':
      return PFN[String(v)]?.word ?? JSON.stringify(v);
    case 'number':
      return typeof v === 'number' ? `${v}${item.unit ? ` ${item.unit}` : ''}` : JSON.stringify(v);
    case 'text':
      return typeof v === 'string' ? v : JSON.stringify(v);
    case 'photo': {
      const n = refsIn(v).length;
      return `${n} photo${n === 1 ? '' : 's'}`;
    }
    case 'signature':
      return refsIn(v).length ? 'Signature' : JSON.stringify(v);
  }
}

/** The status word for a rendered item: conflict first, then unanswered, then invalid, then the answer itself. */
export function shown(i: RenderedItem): Shown {
  if (i.conflict) return { word: 'Needs resolving', glyph: '◆', tone: 'warn' };
  if (!i.answered) return i.item.type === 'signature' ? { word: 'Not signed yet', glyph: '○', tone: 'open' } : { word: 'Not answered', glyph: '○', tone: 'open' };
  if (!i.valid) return { word: `${valueText(i.item, i.value)} · does not fit this item`, glyph: '✕', tone: 'fail' };
  if (i.item.type === 'pass_fail_na') return PFN[String(i.value)]!;
  if (i.item.type === 'signature') return { word: 'Signed', glyph: '✓', tone: 'ok' };
  return { word: valueText(i.item, i.value), glyph: '✓', tone: 'ok' };
}

/** "5 of 8 answered": answered items over all items of the pinned version. */
export function progress(sections: { items: RenderedItem[] }[]): { answered: number; total: number } {
  const all = sections.flatMap((s) => s.items);
  return { answered: all.filter((i) => i.answered).length, total: all.length };
}
