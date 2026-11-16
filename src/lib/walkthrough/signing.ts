// What a customer signature covers (review fix 2026-11-16, should-fix 3, D-41). Pure apart from Web Crypto, so the
// device (which binds a signature when it is captured, offline) and the server (which checks it in the report) share
// one definition. A signature answer is `{ image, answers, ops }`: the image's hash, a digest of every non-signature
// answer the device showed when the customer signed, and how many answers (set ops) its log held then. A bare hash
// (a signature captured before D-41) is "unbound": shown, but never claimed to cover the answers.
import type { Json, Log } from '@/lib/sync';
import { materialize } from '@/lib/sync';
import { hashOf, isHash } from './blobs';
import { renderInspection, type RenderedInspection } from './render';
import type { TemplateDefinition } from './template';

export type SignatureValue = { image: string; answers: string; ops: number };

const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);

export function isSignatureValue(v: Json): v is SignatureValue & { [k: string]: Json } {
  if (!isObj(v)) return false;
  const keys = Object.keys(v).sort();
  return keys.join() === 'answers,image,ops' && isHash(v.image) && isHash(v.answers) && Number.isInteger(v.ops) && (v.ops as number) >= 0;
}

/** The image hash a signature answer names (bound or bare), or null. */
export const signatureImage = (v: Json): string | null => (isHash(v) ? v : isSignatureValue(v) ? v.image : null);

/** JSON with sorted object keys, so equal values always digest the same. */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k]!)}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Every answer except signatures, as signed: path → value, or path → every competing value while it is in conflict
 * (so resolving a conflict after signing counts as a change). Unanswered items are left out.
 */
export function signedAnswers(r: RenderedInspection): [string, Json][] {
  const out: [string, Json][] = [];
  const add = (path: string, value: Json, conflict: boolean, heads: { value: Json }[]) => {
    if (conflict) out.push([path, { conflict: heads.map((h) => canonical(h.value)).sort() }]);
    else if (value !== null) out.push([path, value]);
  };
  for (const s of r.sections) for (const i of s.items) if (i.item.type !== 'signature') add(i.path, i.value, i.conflict, i.heads);
  for (const u of r.unknownFields) add(u.path, u.field.value, u.field.conflict, u.field.heads);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export const answersDigest = (r: RenderedInspection) => hashOf(new TextEncoder().encode(canonical(signedAnswers(r).map(([p, v]) => [p, v]))));

/** Bind a newly captured signature image to what the device shows now (its log, rendered against the pinned version). */
export async function bindSignature(definition: TemplateDefinition, templateVersion: number, log: Log, image: string): Promise<SignatureValue> {
  const r = renderInspection(definition, templateVersion, materialize(log));
  const ops = [...log.values()].filter((o) => o.kind === 'set').length;
  return { image, answers: await answersDigest(r), ops };
}

export type Binding = { status: 'bound' } | { status: 'changed'; ops: number } | { status: 'unbound' };

/** Whether a signature answer still covers the answers in `r`. */
export async function bindingOf(value: Json, r: RenderedInspection): Promise<Binding> {
  if (!isSignatureValue(value)) return { status: 'unbound' };
  return value.answers === (await answersDigest(r)) ? { status: 'bound' } : { status: 'changed', ops: value.ops };
}
