// WT-04: an inspection renders against its pinned template version. Pure: no I/O.
import type { FieldState, InspectionState, Json } from '@/lib/sync';
import { itemPath, validAnswer, type TemplateDefinition, type TemplateItem } from './template';

export interface RenderedItem {
  item: TemplateItem;
  path: string;
  /** Displayed value (null: not answered). */
  value: Json;
  answered: boolean;
  /** False when the displayed value does not fit the item (shown anyway, flagged). */
  valid: boolean;
  conflict: boolean;
  heads: FieldState['heads'];
}

export interface RenderedInspection {
  templateVersion: number;
  sections: { key: string; title: string; items: RenderedItem[] }[];
  /** Fields that hold values but are not items of the pinned version (a stale client): kept visible, never dropped. */
  unknownFields: { path: string; field: FieldState }[];
  /** The "resolve" badge: every conflicting path, including off-template answers (D-14). */
  conflicts: string[];
  missingRequired: string[];
}

/**
 * Render `state` against `definition`, which must be the pinned version (`state.pin.templateVersion`). Throws if the
 * caller passes any other version, so a page can never silently render an inspection against the wrong template.
 */
export function renderInspection(definition: TemplateDefinition, version: number, state: InspectionState): RenderedInspection {
  if (!state.pin) throw new Error('inspection has no server-issued pin');
  if (state.pin.templateVersion !== version) throw new Error(`pinned to version ${state.pin.templateVersion}, not ${version}`);
  const known = new Set<string>();
  const missingRequired: string[] = [];
  const sections = definition.sections.map((s) => ({
    key: s.key,
    title: s.title,
    items: s.items.map((item): RenderedItem => {
      const path = itemPath(item.key);
      known.add(path);
      const f = state.fields[path];
      const value = f ? f.value : null;
      const answered = value !== null;
      if (item.required && !answered) missingRequired.push(path);
      return { item, path, value, answered, valid: validAnswer(item, value), conflict: f?.conflict ?? false, heads: f?.heads ?? [] };
    }),
  }));
  const unknownFields = Object.keys(state.fields)
    .filter((p) => !known.has(p))
    .sort()
    .map((path) => ({ path, field: state.fields[path]! }));
  return { templateVersion: version, sections, unknownFields, conflicts: state.conflicts, missingRequired };
}
