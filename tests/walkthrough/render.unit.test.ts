import { describe, expect, it } from 'vitest';
import { createInspection, createReplica, localSet, materialize, receive, SERVER_ID } from '@/lib/sync';
import { renderInspection } from '@/lib/walkthrough/render';
import type { TemplateDefinition } from '@/lib/walkthrough/template';

// A8 / WT-04: an inspection renders against its pinned version; answers the pinned version does not know are kept
// visible, and off-template answers are badged (D-14).
const v1: TemplateDefinition = { sections: [{ key: 's', title: 'S', items: [{ key: 'roof', label: 'Roof', type: 'pass_fail_na', required: true }, { key: 'temp', label: 'Temp', type: 'number', min: 40, max: 80, required: false }] }] };

function setup() {
  const server = createReplica(SERVER_ID, 'i1');
  const pin = createInspection(server, 't1', 1);
  const dev = createReplica('d1', 'i1');
  receive(dev, [pin]);
  return { server, dev, pin };
}

describe('renderInspection (WT-04)', () => {
  it('renders the pinned version, with required items missing and invalid values flagged, not dropped', () => {
    const { dev } = setup();
    localSet(dev, 'items.temp', 95);
    const view = renderInspection(v1, 1, materialize(dev.log));
    expect(view.sections[0]!.items.map((i) => [i.path, i.value, i.valid])).toEqual([
      ['items.roof', null, true],
      ['items.temp', 95, false],
    ]);
    expect(view.missingRequired).toEqual(['items.roof']);
  });

  it('refuses to render against any version but the pinned one', () => {
    const { dev } = setup();
    expect(() => renderInspection(v1, 2, materialize(dev.log))).toThrow('pinned to version 1');
  });

  it('keeps a stale client\'s answers: off-template heads are badged, unknown paths listed', () => {
    const { dev } = setup();
    localSet(dev, 'items.roof', 'pass');
    const stale = createReplica('d2', 'i1', 2); // a client still rendering version 2, before it pulls the pin
    stale.log = new Map(dev.log); // it has the log, but writes as version 2 (simulates the stale client of D-14)
    stale.clock = dev.clock;
    stale.templateVersion = 2;
    const off = { ...localSet(stale, 'items.roof', 'fail') };
    localSet(stale, 'items.chimney', 'pass');
    receive(dev, [...stale.log.values()]);
    const view = renderInspection(v1, 1, materialize(dev.log));
    const roof = view.sections[0]!.items[0]!;
    expect(roof.conflict).toBe(true);
    expect(roof.heads.find((h) => h.opId === off.opId)).toMatchObject({ offTemplate: true, templateVersion: 2, value: 'fail' });
    expect(view.conflicts).toContain('items.roof');
    expect(view.unknownFields.map((u) => u.path)).toEqual(['items.chimney']);
  });
});
