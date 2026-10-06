/**
 * The raw editor's two formats: a scope's variables written out whole, as a
 * `.env` or as JSON, and what somebody types back read as the scope's complete
 * new set - the way Railway's raw editor works, where a line deleted is a
 * variable removed.
 *
 * Every value is written in double quotes on one line, with a newline, a
 * quote or a backslash in it escaped, so `parseDotEnv` with escapes reads back
 * exactly what was written - spaces, hashes, quotes and a value of several
 * lines (a PEM key, a JSON blob) included.
 *
 * Pure, and client-safe: the editor stages what was typed for review, and the
 * save goes through the same difference as every other edit.
 */

import { parseDotEnv } from "./dotenv";
import {
    VARIABLE_KEY,
    stageDotEnv,
    type VariableDraft,
    type VariableRow
} from "./variable-changes";

export type RawFormat = "env" | "json";

export interface RawEntry {
    readonly key: string;
    readonly value: string;
}

/** Why typed text could not be read, for the editor to say in its own words. */
export type RawRefusal =
    | { readonly ok: false; readonly error: "unreadable" | "notObject" }
    | { readonly ok: false; readonly error: "notText" | "badKey"; readonly key: string };

/**
 * The set as the editor has it now: every row not staged for removal, with the
 * value typed over it or else its value in `values` (by id) or its listed one,
 * then every new variable staged that has a name.
 */
export function draftEntries(
    rows: readonly VariableRow[],
    draft: VariableDraft,
    values: Readonly<Record<string, string>>
): RawEntry[] {
    const removed = new Set(draft.removed);
    const kept = rows
        .filter((row) => !removed.has(row.id))
        .map((row) => ({
            key: row.key,
            value: draft.edits[row.id]?.value ?? values[row.id] ?? row.value ?? ""
        }));
    const added = draft.added
        .filter((item) => item.key.trim())
        .map((item) => ({ key: item.key.trim(), value: item.value }));
    return [...kept, ...added];
}

const ENV_ESCAPE = /[\\"\n\r\t]/g;
const ENV_ESCAPED: Readonly<Record<string, string>> = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t"
};

/** The entries as text. */
export function renderRaw(entries: readonly RawEntry[], format: RawFormat): string {
    if (format === "json") {
        const object = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
        return `${JSON.stringify(object, null, 2)}\n`;
    }
    return entries
        .map(
            ({ key, value }) =>
                `${key}="${value.replace(ENV_ESCAPE, (char) => ENV_ESCAPED[char] ?? char)}"\n`
        )
        .join("");
}

/** The text as entries, the last of a key written twice winning. */
export function parseRaw(
    text: string,
    format: RawFormat
): { readonly ok: true; readonly entries: RawEntry[] } | RawRefusal {
    let entries: RawEntry[];
    if (format === "env") {
        entries = parseDotEnv(text, { escapes: true });
    } else {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text) as unknown;
        } catch {
            return { ok: false, error: "unreadable" };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return { ok: false, error: "notObject" };
        entries = [];
        for (const [key, value] of Object.entries(parsed)) {
            if (!VARIABLE_KEY.test(key)) return { ok: false, error: "badKey", key };
            if (typeof value !== "string") return { ok: false, error: "notText", key };
            entries.push({ key, value });
        }
    }
    const last = new Map<string, string>();
    for (const entry of entries) {
        last.delete(entry.key);
        last.set(entry.key, entry.value);
    }
    return { ok: true, entries: [...last].map(([key, value]) => ({ key, value })) };
}

/**
 * Stage the typed text as the scope's whole new set: a key it has becomes an
 * edit or a new variable (`stageDotEnv`), a stored key it lacks is removed,
 * and a new variable staged earlier that it lacks is dropped.
 */
export function stageReplacement(
    rows: readonly VariableRow[],
    draft: VariableDraft,
    entries: readonly RawEntry[],
    isSecret: boolean,
    nextId: () => string
): VariableDraft {
    const keys = new Set(entries.map((entry) => entry.key));
    const kept: VariableDraft = {
        ...draft,
        added: draft.added.filter((item) => keys.has(item.key.trim()))
    };
    const staged = stageDotEnv(rows, kept, entries, isSecret, nextId);
    const removed = new Set(staged.removed);
    for (const row of rows) if (!keys.has(row.key)) removed.add(row.id);
    return { ...staged, removed: [...removed] };
}
