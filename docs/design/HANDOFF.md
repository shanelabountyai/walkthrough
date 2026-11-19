# Design handoff

Source of truth for the UI built on branch `design/impl`. Exported 2026-11-18 from the Claude Design canvas so cloud runs don't depend on artifact access.

- Canvas: https://claude.ai/artifact/34bte4EhUD5j8Ac5pEUizz
- Brief: https://claude.ai/artifact/9J7Quwb7Cm4Y7C3JrxDyYQ

## Artboards (`docs/design/*.dc.html`)

Each file is a self-contained Design Component: HTML with inline styles, `{{holes}}` filled by the `renderVals()` script at the bottom. Read the markup and the script together; the script holds the sample data.

| File | Screen | Frame |
| --- | --- | --- |
| `Main.dc.html` | Field: checklist runner (offline toggle) — 390 px | 390×1300 |
| `Conflict.dc.html` | Field: resolve a conflict — 390 px | 390×900 |
| `Admin.dc.html` | Office: inspection detail — desktop | 1280×1100 |

## Owner calls (binding)

- Server pins the template version at inspection creation; devices can't change it. (Shane, 2026-11-14)
- Brief open questions not answered by Shane; the design took these readings: a technician CAN resolve a conflict in the field (Conflict artboard) and the office can too, first pick wins, the other value stays in history; one visual identity with Truckroll; signature is draw or type. Record each as a DECISIONS row.

## Gaps: screens the PRD needs that no artboard covers

- Template editor with versions
- Inspections and templates lists
- PDF report layout (photos + signature)
- Field inspection list (assigned to me)

Design each gap as a new `docs/design/<Name>.dc.html` in the same look before building it.

Gap designs added 2026-11-18 (design pass, Claude, owner away): `FieldList.dc.html` (field: my inspections), `InspectionsList.dc.html` (office: inspections + new inspection), `Templates.dc.html` (office: templates + new template), `TemplateEditor.dc.html` (office: template versions + publish), `Report.dc.html` (PDF report page). They use `[placeholders]` only; the app fills real data.

## Placeholders

[Synthetic address] and [photo] are placeholders.
