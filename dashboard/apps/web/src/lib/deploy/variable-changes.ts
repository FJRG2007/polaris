/**
 * Edits to a scope's variables, held in the browser until they are saved, and
 * the difference they make - which is all that is sent.
 *
 * A secret comes to the page masked, so the page cannot tell a secret it never
 * saw from one it should keep: saving everything would mean sending the mask
 * back as the value. Only what somebody actually typed, toggled or removed goes
 * to the server, and a secret nobody touched stays exactly as it is stored.
 *
 * Pure, and shared with the server action, so the browser and the server check
 * a change against the same rules.
 */

import { z } from "zod";
import { ENV_VALUE_MAX, envValueMessage, hasControlCharacter } from "@polaris/core";

/** What an environment variable may be called. */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VARIABLE_KEY_MESSAGE = "Letters, digits and underscores, not starting with a digit";

/** A variable as listed: a secret's value is null. */
export interface VariableRow {
    readonly id: string;
    readonly key: string;
    readonly isSecret: boolean;
    readonly value: string | null;
}

export interface AddedVariable {
    readonly tempId: string;
    readonly key: string;
    readonly value: string;
    readonly isSecret: boolean;
}

export interface VariableDraft {
    /** Per existing row: a value typed over it, or its secrecy flipped. */
    readonly edits: Readonly<Record<string, { readonly value?: string; readonly isSecret?: boolean }>>;
    readonly added: readonly AddedVariable[];
    readonly removed: readonly string[];
}

export const EMPTY_DRAFT: VariableDraft = { edits: {}, added: [], removed: [] };

const MAX_CHANGES = 500;
const MAX_VALUE = ENV_VALUE_MAX;

const trimmedId = z.string().trim().min(1).max(100);

/** The change set as the server receives it. */
export const variableChangesSchema = z
    .object({
        scope: z.enum(["application", "environment"]),
        scopeId: trimmedId,
        set: z
            .array(
                z.object({
                    key: z.string().trim().max(256).regex(VARIABLE_KEY, VARIABLE_KEY_MESSAGE),
                    value: z.string().max(MAX_VALUE, "That value is too long"),
                    isSecret: z.boolean()
                })
            )
            .max(MAX_CHANGES),
        secrecy: z.array(z.object({ id: trimmedId, isSecret: z.boolean() })).max(MAX_CHANGES),
        remove: z.array(trimmedId).max(MAX_CHANGES),
        redeploy: z.boolean()
    })
    .superRefine((input, context) => {
        const seen = new Set<string>();
        input.set.forEach((item, index) => {
            if (seen.has(item.key)) {
                context.addIssue({ code: "custom", message: `${item.key} is set twice`, path: ["set"] });
            }
            if (hasControlCharacter(item.value)) {
                context.addIssue({ code: "custom", message: envValueMessage(item.key), path: ["set", index, "value"] });
            }
            seen.add(item.key);
        });
    });

export type VariableChanges = Omit<z.infer<typeof variableChangesSchema>, "scope" | "scopeId" | "redeploy">;

/** How a secret the page never saw is left alone: its field was opened and left empty. */
function secretUntouched(row: VariableRow, value: string, revealed: Readonly<Record<string, string>>): boolean {
    return row.isSecret && revealed[row.id] === undefined && value === "";
}

/** Whether a row's typed value differs from what is stored. */
export function valueChanged(
    row: VariableRow,
    value: string | undefined,
    revealed: Readonly<Record<string, string>>
): boolean {
    if (value === undefined || secretUntouched(row, value, revealed)) return false;
    const known = row.isSecret ? revealed[row.id] : (row.value ?? "");
    // A secret nobody revealed cannot be compared, so anything typed over it counts.
    return known === undefined || value !== known;
}

/** The difference the draft makes, and nothing else. */
export function variableChanges(
    rows: readonly VariableRow[],
    draft: VariableDraft,
    revealed: Readonly<Record<string, string>> = {}
): VariableChanges {
    const removed = new Set(draft.removed);
    const changes: VariableChanges = { set: [], secrecy: [], remove: [] };
    for (const row of rows) {
        if (removed.has(row.id)) {
            changes.remove.push(row.id);
            continue;
        }
        const edit = draft.edits[row.id];
        if (!edit) continue;
        const isSecret = edit.isSecret ?? row.isSecret;
        if (valueChanged(row, edit.value, revealed)) {
            changes.set.push({ key: row.key, value: edit.value ?? "", isSecret });
        } else if (isSecret !== row.isSecret) {
            changes.secrecy.push({ id: row.id, isSecret });
        }
    }
    for (const item of draft.added) {
        const key = item.key.trim();
        if (key) changes.set.push({ key, value: item.value, isSecret: item.isSecret });
    }
    return changes;
}

export function changeCount(changes: VariableChanges): number {
    return changes.set.length + changes.secrecy.length + changes.remove.length;
}

/** What is wrong with each new variable, by its temporary id; empty when nothing is. */
export function draftErrors(rows: readonly VariableRow[], draft: VariableDraft): Record<string, string> {
    const errors: Record<string, string> = {};
    const removed = new Set(draft.removed);
    const existing = new Set(rows.filter((row) => !removed.has(row.id)).map((row) => row.key));
    const seen = new Set<string>();
    for (const item of draft.added) {
        const key = item.key.trim();
        if (!key) errors[item.tempId] = "Give it a name";
        else if (!VARIABLE_KEY.test(key)) errors[item.tempId] = VARIABLE_KEY_MESSAGE;
        else if (existing.has(key)) errors[item.tempId] = `${key} is already set - change it in its row`;
        else if (seen.has(key)) errors[item.tempId] = `${key} is listed twice`;
        else if (item.value.length > MAX_VALUE) errors[item.tempId] = "That value is too long";
        else if (hasControlCharacter(item.value)) errors[item.tempId] = envValueMessage(key);
        seen.add(key);
    }
    return errors;
}

/**
 * Stage a pasted `.env` for review: a key already set becomes an edit to its
 * row, keeping whether it is secret; a new key becomes a new variable.
 */
export function stageDotEnv(
    rows: readonly VariableRow[],
    draft: VariableDraft,
    parsed: readonly { key: string; value: string }[],
    isSecret: boolean,
    nextId: () => string
): VariableDraft {
    const edits = { ...draft.edits };
    let added = [...draft.added];
    const removed = new Set(draft.removed);
    for (const { key, value } of parsed) {
        const row = rows.find((one) => one.key === key);
        if (row) {
            edits[row.id] = { ...edits[row.id], value };
            removed.delete(row.id);
            continue;
        }
        const already = added.find((one) => one.key.trim() === key);
        if (already) added = added.map((one) => (one === already ? { ...one, value } : one));
        else added.push({ tempId: nextId(), key, value, isSecret });
    }
    return { edits, added, removed: [...removed] };
}
