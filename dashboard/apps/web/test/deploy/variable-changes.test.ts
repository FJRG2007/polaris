/**
 * Only what somebody changed is sent. A secret arrives masked, so the one thing
 * the editor must never do is send a secret nobody touched - that would write the
 * mask, or nothing, over the real value.
 */

import { describe, expect, it } from "vitest";
import {
    changeCount,
    draftErrors,
    EMPTY_DRAFT,
    stageDotEnv,
    variableChanges,
    variableChangesSchema,
    type VariableRow
} from "@/lib/deploy/variable-changes";

const ROWS: VariableRow[] = [
    { id: "s1", key: "API_TOKEN", isSecret: true, value: null },
    { id: "p1", key: "NODE_ENV", isSecret: false, value: "production" },
    { id: "p2", key: "LOG_LEVEL", isSecret: false, value: "info" }
];

describe("variableChanges", () => {
    it("sends nothing for an untouched editor", () => {
        expect(changeCount(variableChanges(ROWS, EMPTY_DRAFT))).toBe(0);
    });

    it("never sends a secret that was opened and left empty, or a plain value typed back as it was", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            edits: { s1: { value: "" }, p1: { value: "production" } }
        });
        expect(changeCount(changes)).toBe(0);
    });

    it("sends a secret only when a new value was typed over it", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            edits: { s1: { value: "new-token" } }
        });
        expect(changes.set).toEqual([{ key: "API_TOKEN", value: "new-token", isSecret: true }]);
    });

    it("compares a revealed secret with what was revealed", () => {
        const revealed = { s1: "old-token" };
        expect(
            changeCount(
                variableChanges(
                    ROWS,
                    { ...EMPTY_DRAFT, edits: { s1: { value: "old-token" } } },
                    revealed
                )
            )
        ).toBe(0);
        expect(
            variableChanges(ROWS, { ...EMPTY_DRAFT, edits: { s1: { value: "rotated" } } }, revealed)
                .set
        ).toHaveLength(1);
    });

    it("flips secrecy without sending a value", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            edits: { s1: { isSecret: false }, p2: { isSecret: true } }
        });
        expect(changes.set).toEqual([]);
        expect(changes.secrecy).toEqual([
            { id: "s1", isSecret: false },
            { id: "p2", isSecret: true }
        ]);
    });

    it("carries the new flag with a changed value rather than as a second change", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            edits: { p2: { value: "debug", isSecret: true } }
        });
        expect(changes.set).toEqual([{ key: "LOG_LEVEL", value: "debug", isSecret: true }]);
        expect(changes.secrecy).toEqual([]);
    });

    it("sends a removal as an id and ignores an edit to a row being removed", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            edits: { p1: { value: "staging" } },
            removed: ["p1"]
        });
        expect(changes).toEqual({ set: [], secrecy: [], remove: ["p1"] });
    });

    it("adds new variables with their names trimmed", () => {
        const changes = variableChanges(ROWS, {
            ...EMPTY_DRAFT,
            added: [{ tempId: "n1", key: "  PORT ", value: "8080", isSecret: false }]
        });
        expect(changes.set).toEqual([{ key: "PORT", value: "8080", isSecret: false }]);
    });
});

describe("draftErrors", () => {
    it("names what is wrong with each new variable", () => {
        const errors = draftErrors(ROWS, {
            ...EMPTY_DRAFT,
            added: [
                { tempId: "a", key: "", value: "", isSecret: true },
                { tempId: "b", key: "1BAD", value: "", isSecret: true },
                { tempId: "c", key: "NODE_ENV", value: "", isSecret: true },
                { tempId: "d", key: "NEW", value: "", isSecret: true },
                { tempId: "e", key: "NEW", value: "", isSecret: true }
            ]
        });
        expect(errors.a).toBe("Give it a name");
        expect(errors.b).toContain("Letters, digits and underscores");
        expect(errors.c).toContain("already set");
        expect(errors.d).toBeUndefined();
        expect(errors.e).toContain("listed twice");
    });

    it("lets a name be reused once the row that had it is being removed", () => {
        const errors = draftErrors(ROWS, {
            ...EMPTY_DRAFT,
            removed: ["p1"],
            added: [{ tempId: "a", key: "NODE_ENV", value: "x", isSecret: false }]
        });
        expect(errors).toEqual({});
    });
});

describe("stageDotEnv", () => {
    it("turns a pasted key already set into an edit of its row, keeping its secrecy", () => {
        let id = 0;
        const draft = stageDotEnv(
            ROWS,
            EMPTY_DRAFT,
            [
                { key: "API_TOKEN", value: "pasted" },
                { key: "FRESH", value: "1" }
            ],
            false,
            () => `n${++id}`
        );
        expect(draft.edits.s1).toEqual({ value: "pasted" });
        expect(draft.added).toEqual([{ tempId: "n1", key: "FRESH", value: "1", isSecret: false }]);
        expect(variableChanges(ROWS, draft).set).toEqual([
            { key: "API_TOKEN", value: "pasted", isSecret: true },
            { key: "FRESH", value: "1", isSecret: false }
        ]);
    });
});

describe("variableChangesSchema", () => {
    const base = { scope: "application", scopeId: "app", secrecy: [], remove: [], redeploy: false };

    it("refuses a key the deploy could not use, and the same key twice", () => {
        expect(
            variableChangesSchema.safeParse({
                ...base,
                set: [{ key: "has space", value: "", isSecret: false }]
            }).success
        ).toBe(false);
        const twice = variableChangesSchema.safeParse({
            ...base,
            set: [
                { key: "A", value: "1", isSecret: false },
                { key: "A", value: "2", isSecret: false }
            ]
        });
        expect(twice.success).toBe(false);
    });

    it("trims a key before checking it", () => {
        const parsed = variableChangesSchema.safeParse({
            ...base,
            set: [{ key: " PORT ", value: "1", isSecret: false }]
        });
        expect(parsed.success && parsed.data.set[0]?.key).toBe("PORT");
    });
});
