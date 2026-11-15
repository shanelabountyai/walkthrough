import { describe, expect, it } from 'vitest';
import { definitionSchema, EXAMPLE_DEFINITION, itemPath, parseDefinition, validAnswer, type TemplateItem } from '@/lib/walkthrough/template';

// A2: template definitions validate — item types, number ranges, unique keys.
const def = (items: unknown[], extra: unknown[] = []) => JSON.stringify({ sections: [{ key: 's', title: 'S', items }, ...extra] });

describe('template definitions (A2)', () => {
  it('accepts every item type from the PRD, and the example template', () => {
    expect(definitionSchema.safeParse(EXAMPLE_DEFINITION).success).toBe(true);
    const r = parseDefinition(
      def([
        { key: 'a', label: 'A', type: 'pass_fail_na' },
        { key: 'b', label: 'B', type: 'number', min: 0, max: 10, unit: 'psi' },
        { key: 'c', label: 'C', type: 'text', maxLength: 50 },
        { key: 'd', label: 'D', type: 'photo', required: true },
        { key: 'e', label: 'E', type: 'signature' },
      ]),
    );
    expect('definition' in r && r.definition.sections[0]!.items.map((i) => i.type)).toEqual(['pass_fail_na', 'number', 'text', 'photo', 'signature']);
    expect('definition' in r && r.definition.sections[0]!.items[0]!.required).toBe(false); // default
  });

  it.each([
    ['not JSON', '{', 'not valid JSON'],
    ['no sections', JSON.stringify({ sections: [] }), 'sections'],
    ['unknown type', def([{ key: 'a', label: 'A', type: 'video' }]), 'items'],
    ['min > max', def([{ key: 'a', label: 'A', type: 'number', min: 5, max: 1 }]), 'min ≤ max'],
    ['bad key', def([{ key: 'Roof 1', label: 'A', type: 'text' }]), 'Keys are'],
    ['unknown field', def([{ key: 'a', label: 'A', type: 'text', colour: 'red' }]), ''],
    ['duplicate item key across sections', def([{ key: 'a', label: 'A', type: 'text' }], [{ key: 't', title: 'T', items: [{ key: 'a', label: 'A2', type: 'text' }] }]), 'Item key "a" is used twice'],
    ['duplicate section key', def([{ key: 'a', label: 'A', type: 'text' }], [{ key: 's', title: 'T', items: [{ key: 'b', label: 'B', type: 'text' }] }]), 'Section key "s"'],
  ])('refuses %s', (_, text, message) => {
    const r = parseDefinition(text);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain(message);
  });

  it('answers live at items.<key>', () => expect(itemPath('roof-condition')).toBe('items.roof-condition'));

  it('validates answers per item type; null is "not answered"', () => {
    const item = (i: Record<string, unknown>) => i as TemplateItem;
    const hash = `sha256:${'a'.repeat(64)}`;
    const cases: [TemplateItem, unknown, boolean][] = [
      [item({ type: 'pass_fail_na' }), 'na', true],
      [item({ type: 'pass_fail_na' }), 'maybe', false],
      [item({ type: 'number', min: 40, max: 80 }), 72, true],
      [item({ type: 'number', min: 40, max: 80 }), 81, false],
      [item({ type: 'number' }), '72', false],
      [item({ type: 'text', maxLength: 3 }), 'abc', true],
      [item({ type: 'text', maxLength: 3 }), 'abcd', false],
      [item({ type: 'photo' }), [hash], true],
      [item({ type: 'photo' }), ['x'], false],
      [item({ type: 'signature' }), hash, true],
      [item({ type: 'signature' }), 'scribble', false],
      [item({ type: 'text', maxLength: 3 }), null, true],
    ];
    for (const [i, v, ok] of cases) expect(validAnswer(i, v as never), `${i.type} ${JSON.stringify(v)}`).toBe(ok);
  });
});
