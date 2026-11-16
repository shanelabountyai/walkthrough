import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createInspection, createReplica, localSet, materialize, receive, SERVER_ID, type Json } from '@/lib/sync';
import { hashOf } from '@/lib/walkthrough/blobs';
import { renderInspection } from '@/lib/walkthrough/render';
import { buildPdf, readiness, reportRefs } from '@/lib/walkthrough/report';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';
import { BLUE_PNG, GREEN_JPEG, RED_JPEG } from './images';

// C7 readiness and C8 the PDF itself (docs/walkthrough/PHASE4_PLAN.md).
const ID = '00000000-0000-4000-8000-000000000029';

/** A device's merged view after `answers` (and optionally a second device's concurrent `rival` answers). */
function rendered(answers: Record<string, Json>, rival: Record<string, Json> = {}) {
  const server = createReplica(SERVER_ID, ID);
  const pin = createInspection(server, 't1', 1);
  const [a, b] = [createReplica('dev-a', ID), createReplica('dev-b', ID)];
  receive(a, [pin]);
  receive(b, [pin]);
  for (const [k, v] of Object.entries(answers)) localSet(a, `items.${k}`, v);
  for (const [k, v] of Object.entries(rival)) localSet(b, `items.${k}`, v);
  receive(a, b.log.values());
  return renderInspection(EXAMPLE_DEFINITION, 1, materialize(a.log));
}

async function full() {
  const [p1, p2, sig] = await Promise.all([RED_JPEG, GREEN_JPEG, BLUE_PNG].map(hashOf));
  const r = rendered({ 'roof-condition': 'fail', 'roof-photo': [p1!, p2!], 'supply-temp': 58, 'hvac-notes': 'Filter dirty — replace\nsoon ✓', 'customer-signature': sig! });
  return { r, p1: p1!, p2: p2!, sig: sig! };
}

describe('report readiness (C7)', () => {
  it('ready when every required item is answered, nothing conflicts and every photo and signature is uploaded', async () => {
    const { r, p1, p2, sig } = await full();
    expect(reportRefs(r)).toEqual([p1, p2, sig]);
    expect(readiness(r, new Set([p1, p2, sig]))).toEqual([]);
  });

  it('names what stops it: missing required, conflict, invalid answer, a blob still uploading', async () => {
    const { p1, sig } = await full();
    const r = rendered({ 'roof-condition': 'pass', 'roof-photo': [p1], 'supply-temp': 200, 'customer-signature': sig }, { 'roof-condition': 'fail' });
    expect(readiness(r, new Set([sig])).map((x) => [x.path, x.why])).toEqual([
      ['items.roof-condition', 'conflict'],
      ['items.roof-photo', 'uploading'],
      ['items.supply-temp', 'invalid'],
    ]);
    const empty = rendered({});
    expect(readiness(empty, new Set()).map((x) => x.why)).toEqual(['missing', 'missing', 'missing', 'missing']);
  });
});

/** Every content stream inflated, so drawn text (hex strings for the standard fonts) can be searched. */
function contents(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  let out = '';
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      /* an image stream */
    }
  }
  return out.toUpperCase();
}
const hex = (s: string) => `<${Buffer.from(s, 'latin1').toString('hex').toUpperCase()}>`;

describe('the PDF (C8)', () => {
  it('is a valid PDF holding every section, answer, both photos and the signature', async () => {
    const { r, p1, p2, sig } = await full();
    const blobs = new Map([
      [p1, { bytes: RED_JPEG, contentType: 'image/jpeg' }],
      [p2, { bytes: GREEN_JPEG, contentType: 'image/jpeg' }],
      [sig, { bytes: BLUE_PNG, contentType: 'image/png' }],
    ]);
    const input = { number: 2, title: 'Smith house', templateName: 'House', inspectionId: ID, technician: 'tech@acme.test', completedBy: 'boss@acme.test', generatedAt: new Date('2026-11-16T17:00:00Z'), opSeq: 7, truckroll: 'http://localhost:7800/o/acme/dispatch?date=2026-11-16', rendered: r, blobs };
    const pdf = await buildPdf(input);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe('Smith house — inspection report 2');
    expect(Buffer.from(pdf).toString('latin1').match(/\/Subtype \/Image/g)).toHaveLength(3); // two photos, one signature
    const text = contents(pdf);
    for (const s of ['Smith house', 'Inspection report 2', 'Roof', 'HVAC', 'Roof condition *', 'Fail', '2 photos', '58 ', 'Customer signature *', 'Signed', 'Filter dirty ', 'Technician: tech@acme.test'])
      expect(text, s).toContain(hex(s).slice(0, -1)); // a prefix: wrapped lines may continue the string
    expect(text).toContain(hex('soon ?')); // outside WinAnsi prints as "?", never fails the report
    expect(Buffer.from(await buildPdf(input)).equals(Buffer.from(pdf))).toBe(true); // deterministic for one input
  });

  it('a photo it cannot embed is noted, not fatal', async () => {
    const { r, p1, p2, sig } = await full();
    const pdf = await buildPdf({ number: 1, title: 'T', templateName: 'House', inspectionId: ID, technician: 't', completedBy: 'c', generatedAt: new Date(0), opSeq: 1, truckroll: 'x', rendered: r, blobs: new Map([[p1, { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }], [p2, { bytes: GREEN_JPEG, contentType: 'image/webp' }], [sig, { bytes: BLUE_PNG, contentType: 'image/png' }]]) });
    expect(Buffer.from(pdf).toString('latin1').match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(contents(pdf)).toContain(hex('(image ').slice(0, -1));
  });
});
