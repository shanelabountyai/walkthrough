// How to write a template definition (D-17: JSON, validated by definitionSchema). Shared by both template pages.
export function DefinitionHelp() {
  return (
    <details className="wt-help" id="def-help">
      <summary>How to write a definition</summary>
      <p>
        Sections hold items. Item types: <code>pass_fail_na</code>, <code>number</code> (<code>min</code>, <code>max</code>, <code>unit</code>), <code>text</code> (
        <code>maxLength</code>), <code>photo</code>, <code>signature</code>; each takes <code>required</code>. Item keys are unique across the template.
      </p>
      <p>
        Keys are 1–48 lowercase letters, digits or dashes. A mistake is shown above the form with where it is, for example <code>sections.0.items.2</code>.
      </p>
    </details>
  );
}
