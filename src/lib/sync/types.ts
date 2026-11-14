// Walkthrough sync engine — data types (Phase 1, docs/walkthrough/PHASE1_PLAN.md). Pure: no I/O.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface OpBase {
  /** `${deviceId}:${seq}` — minted by the device, unique across the system. */
  opId: string;
  deviceId: string;
  inspectionId: string;
  /** Lamport clock at write time. */
  lamport: number;
  /** Template version the device was rendering when it wrote this op. */
  templateVersion: number;
}

/** Write one field. `prev` names the values for `path` the writer could see — what this write supersedes. */
export interface SetOp extends OpBase {
  kind: 'set';
  path: string;
  value: Json;
  prev: string[];
}

/** The replica id (and op `deviceId`) of the server. Only the server issues pins (D-15). */
export const SERVER_ID = 'server';

/**
 * Pin the template version an inspection renders against. Issued by the server when the inspection is created,
 * before any device op exists; devices can't create or change it (D-15). `templateVersion` is the pinned version.
 */
export interface PinOp extends OpBase {
  kind: 'pin';
  templateId: string;
}

export type Op = SetOp | PinOp;

/** One inspection's op log: opId → op. Append-only. */
export type Log = ReadonlyMap<string, Op>;

export interface FieldState {
  /** Displayed value: the on-template head (any head if none is on-template) with the greatest (lamport, deviceId, opId). */
  value: Json;
  /** opId of the displayed value. */
  winner: string;
  /**
   * Every head (unsuperseded) op for this field, in total order, oldest first. Length > 1 only on conflict.
   * `offTemplate`: written against a version other than the pinned one — kept visible and badged (D-14).
   */
  heads: { opId: string; deviceId: string; value: Json; templateVersion: number; offTemplate: boolean }[];
  conflict: boolean;
}

export interface InspectionState {
  /** The server-issued pin (D-15). A pin op from any other writer is ignored here and rejected by `serverAccept`. */
  pin: { templateId: string; templateVersion: number; opId: string } | null;
  fields: Record<string, FieldState>;
  /** Paths with a visible conflict (distinct live values, or a live off-template answer), sorted — the "resolve" badge. */
  conflicts: string[];
  /** set ops written against a template version other than the pinned one: kept in the log; a live one stays in its field's heads with a conflict badge (D-14). */
  offTemplate: string[];
}
