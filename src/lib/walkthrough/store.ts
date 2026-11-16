// Walkthrough server side (Phase 2): templates, inspections and the Postgres-backed server replica of each
// inspection's op log. The merge rules are the Phase 1 engine's (src/lib/sync); this file only stores and loads.
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import type { Tx } from '@/core/db/rls';
import { withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { Prisma } from '@/generated/prisma/client';
import type { Role } from '@/generated/prisma/enums';
import {
  createInspection as enginePin,
  createReplica,
  LogIntegrityError,
  materialize,
  PinError,
  sameOp,
  serverAccept,
  SERVER_ID,
  type InspectionState,
  type Json,
  type Op,
} from '@/lib/sync';
import { definitionSchema, parseDefinition, type TemplateDefinition } from './template';
import { truckrollLink } from './truckroll';

// ---- roles (D-16): managers are owner/admin (the template's org.update); a technician is whoever is assigned.

export const isManager = (role: Role) => can(role, 'org.update');

/** WT-05: managers see every inspection in the org; anyone else only the ones assigned to them. */
export const visibleTo = (ctx: OrgCtx) => ({ ...inOrg(ctx), ...(isManager(ctx.role) ? {} : { assigneeId: ctx.userId }) });

// ---- templates

export async function createTemplate(ctx: OrgCtx, name: string, definition: TemplateDefinition) {
  return withOrg(ctx, async (tx) => {
    const t = await tx.checklistTemplate.create({ data: { ...inOrg(ctx), name, createdById: ctx.userId } });
    await tx.templateVersion.create({ data: { ...inOrg(ctx), templateId: t.id, version: 1, definition, createdById: ctx.userId } });
    await audit(ctx, 'template.created', { targetType: 'checklistTemplate', targetId: t.id, data: { version: 1 } }, tx);
    return t;
  });
}

/** Publishes `definition` as version n+1 (D-17: every save is a new immutable version). Another org's id is notFound. */
export async function publishVersion(ctx: OrgCtx, templateId: string, definitionText: string) {
  return withOrg(ctx, async (tx) => {
    const t = await tx.checklistTemplate.findFirst({ where: { id: templateId, ...inOrg(ctx) }, select: { id: true } });
    if (!t) notFound();
    const parsed = parseDefinition(definitionText); // after the lookup: another org's id answers like a missing one, whatever the body
    if ('error' in parsed) throw new Refused(parsed.error);
    const last = await tx.templateVersion.findFirst({ where: { templateId: t.id, ...inOrg(ctx) }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    try {
      await tx.templateVersion.create({ data: { ...inOrg(ctx), templateId: t.id, version, definition: parsed.definition, createdById: ctx.userId } });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new Refused('Someone published a version at the same moment. Reload and try again.');
      throw e;
    }
    await audit(ctx, 'template.version_published', { targetType: 'checklistTemplate', targetId: t.id, data: { version } }, tx);
    return version;
  });
}

// ---- inspections

/**
 * Creates the inspection and, in the same transaction, the server-issued pin (D-15): the engine's
 * `createInspection` on a fresh server replica, stored as op seq 1, pinning the template's latest version.
 * A template or assignee outside this org is notFound (cross-org ≡ nonexistent).
 */
export async function createInspectionRecord(ctx: OrgCtx, input: { templateId: string; assigneeId: string; title: string }) {
  return withOrg(ctx, async (tx) => {
    const latest = await tx.templateVersion.findFirst({
      where: { templateId: input.templateId, ...inOrg(ctx) },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, templateId: true },
    });
    if (!latest) notFound();
    const member = await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: input.assigneeId } }, select: { userId: true } });
    if (!member) notFound();
    const id = randomUUID();
    const server = createReplica(SERVER_ID, id);
    const pin = enginePin(server, latest.templateId, latest.version);
    await tx.inspection.create({
      data: {
        id,
        ...inOrg(ctx),
        templateId: latest.templateId,
        templateVersionId: latest.id,
        templateVersion: latest.version,
        title: input.title,
        assigneeId: member.userId,
        createdById: ctx.userId,
        clock: server.clock,
        opSeq: 1,
      },
    });
    await tx.inspectionOp.create({ data: { ...toRow(pin), ...inOrg(ctx), inspectionId: id, seq: 1, userId: null } });
    await audit(ctx, 'inspection.created', { targetType: 'inspection', targetId: id, data: { templateId: latest.templateId, templateVersion: latest.version, assigneeId: member.userId } }, tx);
    return { id, pin };
  });
}

// ---- op rows ⇄ engine ops. The engine compares ops by canonical content (sameOp), so a row must load back to
// exactly the op that was pushed: same keys, same values.

type OpRow = {
  opId: string;
  deviceId: string;
  inspectionId: string;
  lamport: number;
  kind: string;
  path: string | null;
  value: Prisma.JsonValue | null;
  prev: string[];
  templateId: string | null;
  templateVersion: number;
};

export function fromRow(r: OpRow): Op {
  const base = { opId: r.opId, deviceId: r.deviceId, inspectionId: r.inspectionId, lamport: r.lamport, templateVersion: r.templateVersion };
  if (r.kind === 'pin') return { ...base, kind: 'pin', templateId: r.templateId! };
  return { ...base, kind: 'set', path: r.path!, value: (r.value ?? null) as Json, prev: r.prev };
}

function toRow(op: Op) {
  const base = { opId: op.opId, deviceId: op.deviceId, lamport: op.lamport, kind: op.kind, templateVersion: op.templateVersion };
  return op.kind === 'pin'
    ? { ...base, templateId: op.templateId }
    : { ...base, path: op.path, value: op.value === null ? Prisma.JsonNull : (op.value as Prisma.InputJsonValue), prev: op.prev };
}

const OP_SELECT = { opId: true, deviceId: true, inspectionId: true, lamport: true, kind: true, path: true, value: true, prev: true, templateId: true, templateVersion: true, seq: true } as const;

async function opsAfter(tx: Tx, ctx: OrgCtx, inspectionId: string, since: number) {
  const rows = await tx.inspectionOp.findMany({ where: { inspectionId, ...inOrg(ctx), seq: { gt: since } }, orderBy: { seq: 'asc' }, select: OP_SELECT });
  return rows.map(fromRow);
}

/** The whole log, for materializing (pages and the push merge). */
export async function loadLog(tx: Tx, ctx: OrgCtx, inspectionId: string): Promise<Map<string, Op>> {
  const ops = await opsAfter(tx, ctx, inspectionId, 0);
  return new Map(ops.map((o) => [o.opId, o]));
}

// ---- the wire format (docs/walkthrough/PHASE2_PLAN.md, "Server sync endpoint")

const MAX_INT = 2 ** 31 - 1;
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
const opBase = {
  opId: z.string().min(3).max(100),
  deviceId: z.string().min(1).max(64),
  inspectionId: z.uuid(),
  lamport: z.int().min(1).max(MAX_INT),
  templateVersion: z.int().min(1).max(1_000_000),
};
const setOp = z
  .object({ ...opBase, kind: z.literal('set'), path: z.string().regex(PATH), value: z.json(), prev: z.array(z.string().max(100)).max(64) })
  .strict()
  .refine((o) => JSON.stringify(o.value).length <= 16_000, { message: 'value is over 16 KB' });
const pinOp = z.object({ ...opBase, kind: z.literal('pin'), templateId: z.uuid() }).strict();

export const pushSchema = z
  .object({
    deviceId: z.uuid(),
    since: z.int().min(0).max(MAX_INT).default(0),
    ops: z.array(z.discriminatedUnion('kind', [setOp, pinOp])).max(500),
  })
  .strict();
export type PushInput = z.infer<typeof pushSchema>;

/** A refused push: nothing was stored (the whole batch is refused, never part of it). */
export class SyncRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type PullResult = { ops: Op[]; cursor: number; conflicts: string[] };

/** GET: header, the pinned version's definition (WT-04) and the ops after `since`. null: not visible to this user (WT-05). */
export async function syncPull(ctx: OrgCtx, inspectionId: string, since: number) {
  return withOrg(
    ctx,
    async (tx) => {
      const insp = await tx.inspection.findFirst({
        where: { id: inspectionId, ...visibleTo(ctx) },
        select: { id: true, title: true, templateId: true, templateVersion: true, assigneeId: true, opSeq: true, conflictPaths: true, createdAt: true, pinnedVersion: { select: { definition: true } } },
      });
      if (!insp) return null;
      const ops = await opsAfter(tx, ctx, insp.id, since);
      return {
        inspection: { id: insp.id, title: insp.title, templateId: insp.templateId, templateVersion: insp.templateVersion, assigneeId: insp.assigneeId, truckroll: truckrollLink(ctx.slug, insp.createdAt) },
        template: { version: insp.templateVersion, definition: definitionSchema.parse(insp.pinnedVersion.definition) },
        ops,
        cursor: insp.opSeq,
        conflicts: insp.conflictPaths,
      };
    },
    { atomic: false },
  );
}

/**
 * POST: store a device's ops, then pull. One transaction holding the inspection's row lock, so pushes to one
 * inspection are serialized and `seq` is gapless. Checked before anything is stored:
 *  - the device is bound to this user (D-20), or is new and gets bound;
 *  - every set op is this device's own (deviceId, opId `${deviceId}:n`) and for this inspection;
 *  - the engine's `serverAccept`: a pin that is not the server's own is refused (D-15), and an opId already
 *    stored with different content is refused (LogIntegrityError) — never replaced (WT-01).
 * Ack = the opIds now in the server log, after commit. null: not visible to this user (WT-05).
 */
export async function syncPush(ctx: OrgCtx, inspectionId: string, input: PushInput): Promise<(PullResult & { acked: string[] }) | null> {
  for (const op of input.ops) {
    if (op.inspectionId !== inspectionId) throw new SyncRefused(400, 'wrong-inspection', `op ${op.opId} belongs to another inspection`);
    if (op.kind === 'set' && (op.deviceId !== input.deviceId || !new RegExp(`^${input.deviceId}:[1-9][0-9]{0,9}$`).test(op.opId))) {
      throw new SyncRefused(403, 'foreign-op', `op ${op.opId} was not written by device ${input.deviceId}`);
    }
  }
  const batch = new Map<string, Op>();
  for (const op of input.ops as Op[]) {
    const seen = batch.get(op.opId);
    if (seen && !sameOp(seen, op)) throw new SyncRefused(409, 'integrity', `op ${op.opId} appears twice with different content`);
    batch.set(op.opId, op);
  }
  return withOrg(ctx, async (tx) => {
    const visible = await tx.inspection.findFirst({ where: { id: inspectionId, ...visibleTo(ctx) }, select: { id: true } });
    if (!visible) return null;
    await tx.$queryRaw`SELECT 1 FROM "Inspection" WHERE id = ${inspectionId}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
    const insp = await tx.inspection.findFirstOrThrow({ where: { id: inspectionId, ...inOrg(ctx) }, select: { clock: true, opSeq: true, templateVersion: true } });

    const device = await tx.syncDevice.findUnique({ where: { orgId_id: { orgId: ctx.orgId, id: input.deviceId } }, select: { userId: true } });
    if (device && device.userId !== ctx.userId) throw new SyncRefused(403, 'device-owner', 'this device id is bound to another user');
    if (!device) await tx.syncDevice.create({ data: { ...inOrg(ctx), id: input.deviceId, userId: ctx.userId } });

    const server = createReplica(SERVER_ID, inspectionId, insp.templateVersion);
    server.clock = insp.clock;
    server.log = await loadLog(tx, ctx, inspectionId);
    const before = new Set(server.log.keys());
    let acked: string[];
    try {
      acked = serverAccept(server, [...batch.values()]);
    } catch (e) {
      if (e instanceof PinError) throw new SyncRefused(422, e.reason, e.message);
      if (e instanceof LogIntegrityError) throw new SyncRefused(409, 'integrity', e.message);
      throw e;
    }
    const fresh = [...batch.values()].filter((o) => !before.has(o.opId));
    let seq = insp.opSeq;
    if (fresh.length) {
      await tx.inspectionOp.createMany({ data: fresh.map((op) => ({ ...toRow(op), ...inOrg(ctx), inspectionId, seq: ++seq, userId: ctx.userId })) });
    }
    const state = materialize(server.log);
    if (fresh.length || server.clock !== insp.clock) {
      await tx.inspection.updateMany({ where: { id: inspectionId, ...inOrg(ctx) }, data: { clock: server.clock, opSeq: seq, conflictPaths: state.conflicts } });
    }
    const ops = await opsAfter(tx, ctx, inspectionId, input.since);
    return { acked, ops, cursor: seq, conflicts: state.conflicts };
  });
}

/** The materialized state of an inspection the user can see (pages). */
export async function inspectionState(tx: Tx, ctx: OrgCtx, inspectionId: string): Promise<InspectionState> {
  return materialize(await loadLog(tx, ctx, inspectionId));
}
