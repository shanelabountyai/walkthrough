// The inspection report (Phase 4): when an inspection is ready to complete, and the PDF itself. Pure apart from
// pdf-lib (no I/O): the caller loads the merged state, the pinned definition and the blob bytes.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import type { Json } from '@/lib/sync';
import { refsIn } from './blobs';
import type { RenderedInspection, RenderedItem } from './render';
import { bindingOf, type Binding } from './signing';

export { readiness, reportRefs, WHY, type NotReady } from './readiness';

export interface ReportInput {
  number: number;
  title: string;
  templateName: string;
  inspectionId: string;
  technician: string;
  completedBy: string;
  generatedAt: Date;
  opSeq: number;
  truckroll: string;
  rendered: RenderedInspection;
  blobs: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>;
}

const PFN: Record<string, string> = { pass: 'Pass', fail: 'Fail', na: 'N/A' };

function answerText(i: RenderedItem, binding?: Binding): string {
  const v = i.value;
  if (v === null) return '—';
  switch (i.item.type) {
    case 'pass_fail_na':
      return PFN[String(v)] ?? JSON.stringify(v);
    case 'number':
      return `${v}${i.item.unit ? ` ${i.item.unit}` : ''}`;
    case 'text':
      return String(v);
    case 'photo': {
      const n = refsIn(v).length;
      return `${n} photo${n === 1 ? '' : 's'}`;
    }
    case 'signature':
      // D-41: "Signed" only when the signature covers the answers this report prints.
      if (binding?.status === 'changed') return `ANSWERS CHANGED AFTER SIGNING: this signature is not valid for the answers in this report. The customer signed over an earlier version of the answers (${binding.ops} recorded then); get a new signature.`;
      if (binding?.status === 'unbound') return 'Signed, but this signature does not record which answers it covered (captured before signatures were bound to answers).';
      return 'Signed';
  }
}

const show = (v: Json) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Build the PDF. Deterministic for the same input (fixed dates in the document info). */
export async function buildPdf(input: ReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${input.title} — inspection report ${input.number}`);
  doc.setSubject(`Walkthrough inspection ${input.inspectionId}`);
  doc.setProducer('Walkthrough');
  doc.setCreator('Walkthrough');
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(regular.getCharacterSet());
  // The standard fonts cover WinAnsi only; anything else prints as "?" rather than failing the report.
  const safe = (s: string) => [...s.replace(/\r\n?/g, '\n')].map((ch) => (ch === '\n' || charset.has(ch.codePointAt(0)!) ? ch : '?')).join('');

  const W = 612, H = 792, M = 50, BOTTOM = 60;
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const room = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };
  const wrap = (text: string, font: PDFFont, size: number, width: number) => {
    const lines: string[] = [];
    for (const para of safe(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          if (line) lines.push(line);
          // A single word wider than the line is cut by characters.
          let w = word;
          while (font.widthOfTextAtSize(w, size) > width) {
            let k = w.length - 1;
            while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > width) k--;
            lines.push(w.slice(0, k));
            w = w.slice(k);
          }
          line = w;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  const text = (s: string, opts: { font?: PDFFont; size?: number; indent?: number; color?: [number, number, number] } = {}) => {
    const font = opts.font ?? regular, size = opts.size ?? 11, x = M + (opts.indent ?? 0);
    for (const line of wrap(s, font, size, W - M - x)) {
      room(size + 4);
      page.drawText(line, { x, y: y - size, size, font, color: rgb(...(opts.color ?? [0, 0, 0])) });
      y -= size + 4;
    }
  };
  const embedded = new Map<string, PDFImage | null>();
  const image = async (hash: string) => {
    if (embedded.has(hash)) return embedded.get(hash)!;
    const b = input.blobs.get(hash);
    let img: PDFImage | null = null;
    try {
      if (b?.contentType === 'image/jpeg') img = await doc.embedJpg(b.bytes);
      else if (b?.contentType === 'image/png') img = await doc.embedPng(b.bytes);
    } catch {
      img = null; // unreadable image data: noted in the report, never fatal
    }
    embedded.set(hash, img);
    return img;
  };
  const images = async (hashes: string[], maxW: number, maxH: number) => {
    let x = M + 12;
    let rowH = 0;
    for (const h of hashes) {
      const img = await image(h);
      if (!img) {
        text(`(image ${h.slice(7, 19)}… is not a JPEG or PNG the report can embed)`, { indent: 12, size: 9, color: [0.4, 0.4, 0.4] });
        continue;
      }
      const s = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * s, ih = img.height * s;
      if (x + w > W - M) {
        y -= rowH + 8;
        x = M + 12;
        rowH = 0;
      }
      if (y - ih < BOTTOM) {
        newPage();
        x = M + 12;
        rowH = 0;
      }
      page.drawImage(img, { x, y: y - ih, width: w, height: ih });
      x += w + 10;
      rowH = Math.max(rowH, ih);
    }
    if (rowH) y -= rowH + 8;
  };

  const bindings = new Map<string, Binding>();
  for (const s of input.rendered.sections) for (const i of s.items) if (i.item.type === 'signature' && i.value !== null) bindings.set(i.path, await bindingOf(i.value, input.rendered));
  const stale = [...input.rendered.sections.flatMap((s) => s.items)].filter((i) => bindings.get(i.path)?.status === 'changed');

  // Design pass 2026-11-18 (docs/design/Report.dc.html): a navy band with an amber rule, then the facts, then the
  // sections. Layout only: what the report says, and when it may be built, is unchanged (D-32, D-41).
  const NAVY: [number, number, number] = [0.075, 0.125, 0.169];
  const ON_NAVY: [number, number, number] = [0.83, 0.86, 0.89];
  const MUTED: [number, number, number] = [0.25, 0.3, 0.35];
  newPage();
  const templateLine = `${input.templateName}, template version ${input.rendered.templateVersion} (pinned when the inspection was created)`;
  const bandH = 26 + 14 + wrap(input.title, bold, 20, W - 2 * M).length * 24 + wrap(templateLine, regular, 10, W - 2 * M).length * 14 + 12;
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: rgb(...NAVY) });
  page.drawRectangle({ x: 0, y: H - bandH - 5, width: W, height: 5, color: rgb(0.949, 0.639, 0.227) });
  y = H - 24;
  text(`Walkthrough · Inspection report ${input.number}`, { font: bold, size: 10, color: ON_NAVY });
  y -= 2;
  text(input.title, { font: bold, size: 20, color: [1, 1, 1] });
  text(templateLine, { size: 10, color: ON_NAVY });
  y = H - bandH - 5 - 16;
  const all = input.rendered.sections.flatMap((s) => s.items);
  const count = (v: string) => all.filter((i) => i.item.type === 'pass_fail_na' && i.value === v).length;
  text(`Inspection report ${input.number}`, { font: bold, size: 13 });
  text(`Technician: ${input.technician}`);
  text(`Completed by ${input.completedBy} on ${input.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  text(`Result: ${count('pass')} pass · ${count('fail')} fail · ${count('na')} N/A`);
  text(`Inspection ${input.inspectionId} · built from the op log through seq ${input.opSeq}`, { size: 9, color: MUTED });
  text(`Dispatch day in Truckroll: ${input.truckroll}`, { size: 9, color: MUTED });
  if (stale.length) {
    y -= 6;
    text(`ANSWERS CHANGED AFTER SIGNING: ${stale.map((i) => i.item.label).join(', ')} no longer cover${stale.length === 1 ? 's' : ''} the answers below (D-41).`, { font: bold, color: [0.75, 0, 0] });
  }
  const TONE: Record<string, [number, number, number]> = { pass: [0.122, 0.306, 0.541], fail: [0.706, 0.165, 0.055], na: MUTED };
  for (const s of input.rendered.sections) {
    y -= 12;
    room(15 + 4 + 8);
    text(s.title, { font: bold, size: 15, color: NAVY });
    page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 1.5, color: rgb(...NAVY) });
    y -= 4;
    for (const i of s.items) {
      y -= 2;
      text(`${i.item.label}${i.item.required ? ' *' : ''}`, { font: bold });
      const tone = i.item.type === 'pass_fail_na' && typeof i.value === 'string' ? TONE[i.value] : undefined;
      text(answerText(i, bindings.get(i.path)), {
        indent: 12,
        ...(tone ? { font: bold, color: tone } : {}),
        ...(bindings.get(i.path)?.status === 'changed' ? { font: bold, color: [0.75, 0, 0] as [number, number, number] } : {}),
      });
      if (i.item.type === 'photo') await images(refsIn(i.value), 240, 180);
      if (i.item.type === 'signature' && i.value !== null) await images(refsIn(i.value), 240, 100);
    }
  }
  if (input.rendered.unknownFields.length) {
    y -= 10;
    text(`Answers to items not in version ${input.rendered.templateVersion}`, { font: bold, size: 15 });
    for (const u of input.rendered.unknownFields) text(`${u.path}: ${show(u.field.value)}`, { indent: 12 });
  }
  const pages = doc.getPages();
  pages.forEach((p, n) =>
    p.drawText(safe(`Walkthrough · ${input.title} · report ${input.number} · page ${n + 1} of ${pages.length}`), { x: M, y: 30, size: 8, font: regular, color: rgb(0.45, 0.45, 0.45) }),
  );
  return doc.save({ useObjectStreams: false });
}
