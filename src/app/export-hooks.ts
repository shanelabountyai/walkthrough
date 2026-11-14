import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  // Walkthrough (Phase 2): templates, inspections and the whole op log — the log is the inspection's data.
  { name: 'ChecklistTemplate', rows: (tx, orgId) => tx.checklistTemplate.findMany({ where: { orgId }, select: { id: true, name: true, createdById: true, createdAt: true } }) },
  {
    name: 'TemplateVersion',
    rows: (tx, orgId) => tx.templateVersion.findMany({ where: { orgId }, select: { id: true, templateId: true, version: true, definition: true, createdById: true, createdAt: true } }),
  },
  {
    name: 'Inspection',
    rows: (tx, orgId) =>
      tx.inspection.findMany({
        where: { orgId },
        select: { id: true, templateId: true, templateVersion: true, title: true, assigneeId: true, createdById: true, conflictPaths: true, createdAt: true, updatedAt: true },
      }),
  },
  {
    name: 'InspectionOp',
    rows: (tx, orgId) =>
      tx.inspectionOp.findMany({
        where: { orgId },
        orderBy: [{ inspectionId: 'asc' }, { seq: 'asc' }],
        select: { inspectionId: true, seq: true, opId: true, deviceId: true, lamport: true, kind: true, path: true, value: true, prev: true, templateId: true, templateVersion: true, userId: true, receivedAt: true },
      }),
  },
  { name: 'SyncDevice', rows: (tx, orgId) => tx.syncDevice.findMany({ where: { orgId }, select: { id: true, userId: true, createdAt: true } }) },
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {};
