import { describe, expect, it } from 'vitest';
import { createInspection, createReplica, localSet, materialize, receive, SERVER_ID } from '@/lib/sync';
import { renderInspection } from '@/lib/walkthrough/render';
import type { TemplateDefinition } from '@/lib/walkthrough/template';
import { progress, rangeProblem, rangeText, shown, valueText } from '@/app/ui/answers';

// Design pass 2026-11-18 (PRD "Design, UX and accessibility requirements" DX-01): every status on screen is a word
// first — colour and glyph only repeat it — and an out-of-range number says why in plain words.
const def: TemplateDefinition = {
  sections: [
    {
      key: 's',
      title: 'S',
      items: [
        { key: 'roof', label: 'Roof', type: 'pass_fail_na', required: true },
        { key: 'co', label: 'CO in flue', type: 'number', min: 0, max: 100, unit: 'ppm', required: true },
        { key: 'notes', label: 'Notes', type: 'text', maxLength: 2000, required: false },
        { key: 'sig', label: 'Customer signature', type: 'signature', required: true },
      ],
    },
  ],
};

function view(set: (d: ReturnType<typeof createReplica>) => void) {
  const server = createReplica(SERVER_ID, 'i1');
  const dev = createReplica('d1', 'i1');
  receive(dev, [createInspection(server, 't1', 1)]);
  set(dev);
  return renderInspection(def, 1, materialize(dev.log));
}

describe('answer words (DX-01)', () => {
  it('pass, fail and N/A each have a word, a glyph and a tone', () => {
    const items = view((d) => localSet(d, 'items.roof', 'fail')).sections[0]!.items;
    expect(shown(items[0]!)).toEqual({ word: 'Fail', glyph: '✕', tone: 'fail' });
    expect(shown(items[1]!)).toEqual({ word: 'Not answered', glyph: '○', tone: 'open' });
    expect(shown(items[3]!)).toEqual({ word: 'Not signed yet', glyph: '○', tone: 'open' });
  });

  it('an out-of-range number is shown, flagged in words, never dropped', () => {
    const items = view((d) => localSet(d, 'items.co', 140)).sections[0]!.items;
    expect(shown(items[1]!)).toEqual({ word: '140 ppm · does not fit this item', glyph: '✕', tone: 'fail' });
    expect(rangeProblem(items[1]!.item, 140)).toBe('140 is above the allowed range (0–100 ppm).');
    expect(rangeProblem(items[1]!.item, -1)).toBe('-1 is below the allowed range (0–100 ppm).');
    expect(rangeProblem(items[1]!.item, 14)).toBeNull();
    expect(rangeText(items[1]!.item)).toBe('allowed 0–100 ppm');
  });

  it('a conflict reads "Needs resolving" before anything else, and each kept value reads as text', () => {
    const server = createReplica(SERVER_ID, 'i1');
    const pin = createInspection(server, 't1', 1);
    const a = createReplica('a', 'i1');
    const b = createReplica('b', 'i1');
    receive(a, [pin]);
    receive(b, [pin]);
    const x = localSet(a, 'items.co', 140);
    const y = localSet(b, 'items.co', 14);
    receive(a, [y]);
    receive(b, [x]);
    const item = renderInspection(def, 1, materialize(a.log)).sections[0]!.items[1]!;
    expect(item.conflict).toBe(true);
    expect(shown(item)).toEqual({ word: 'Needs resolving', glyph: '◆', tone: 'warn' });
    expect(item.heads.map((h) => valueText(item.item, h.value)).sort()).toEqual(['14 ppm', '140 ppm']);
  });

  it('progress counts answered items of the pinned version', () => {
    const v = view((d) => {
      localSet(d, 'items.roof', 'pass');
      localSet(d, 'items.notes', 'ok');
    });
    expect(progress(v.sections)).toEqual({ answered: 2, total: 4 });
  });
});
