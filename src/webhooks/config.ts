// Parse the `WEBHOOKS` env var into a list of `WebhookBinding`.
//
// Format: `table.mutation:url,table.mutation:url`. The first `:`
// separates trigger from URL so URLs with colons (e.g. custom
// ports) still parse. The first `.` inside the trigger separates
// table from mutation.
//
// Critique #39 — per-table column allowlist lives on the
// `WebhookBinding` too, so the dispatch layer can filter rows
// before they leave the Worker. The parser recognizes an extended
// form `table.mutation[col1,col2]:url` — columns inside brackets
// become the allowlist. An empty allowlist means "no allowlist"
// (every non-generated column passes through).

export interface WebhookBinding {
  readonly table: string;
  readonly mutation: 'create' | 'update' | 'delete' | 'upsert' | '*';
  readonly url: string;
  /** Column names allowed in the body. Empty = unrestricted. */
  readonly allowedColumns: readonly string[];
}

/**
 * Parse one or more webhook entries from a comma-separated string.
 *
 * Grammar:
 *   entry   := trigger `:` url
 *   trigger := table `.` mutation ( `[` col (`,` col)* `]` )?
 *
 * Returns an empty array for undefined / empty input. Malformed
 * entries are silently dropped rather than erroring at config-load
 * time, so one bad entry doesn't kill the whole Worker.
 */
export function parseWebhookBindings(
  envVar: string | undefined,
): readonly WebhookBinding[] {
  if (envVar === undefined || envVar.trim() === '') return [];

  const out: WebhookBinding[] = [];
  for (const rawEntry of splitEntries(envVar)) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 1) continue;

    const trigger = entry.slice(0, colonIdx).trim();
    const url = entry.slice(colonIdx + 1).trim();
    if (url === '') continue;

    // Split the column allowlist off the trigger.
    let triggerBare = trigger;
    let allowedColumns: readonly string[] = [];
    const bracketIdx = trigger.indexOf('[');
    if (bracketIdx > 0 && trigger.endsWith(']')) {
      triggerBare = trigger.slice(0, bracketIdx);
      const colList = trigger.slice(bracketIdx + 1, -1);
      allowedColumns = colList
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    }

    const dotIdx = triggerBare.indexOf('.');
    if (dotIdx < 0) continue;
    const table = triggerBare.slice(0, dotIdx).trim();
    const mutation = triggerBare.slice(dotIdx + 1).trim();
    if (table === '' || mutation === '') continue;
    if (!isValidMutation(mutation)) continue;

    out.push({
      table,
      mutation: mutation as WebhookBinding['mutation'],
      url,
      allowedColumns,
    });
  }
  return out;
}

function isValidMutation(value: string): boolean {
  return (
    value === 'create' ||
    value === 'update' ||
    value === 'delete' ||
    value === 'upsert' ||
    value === '*'
  );
}

/**
 * Bracket-aware comma split. Commas inside `[...]` (the column
 * allowlist) are preserved; commas outside split entries.
 */
function splitEntries(input: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}
