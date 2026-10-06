/**
 * The raw editor: a scope's variables written out whole, as a `.env` or as
 * JSON, and what is typed back read as the scope's complete new set - a key
 * left out is a key removed, as on Railway.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, variableChanges } from "@/lib/deploy/variable-changes";
import { draftEntries, parseRaw, renderRaw, stageReplacement } from "@/lib/deploy/variable-raw";

const ROWS = [
    { id: "a", key: "DATABASE_URL", isSecret: true, value: null },
    { id: "b", key: "NODE_ENV", isSecret: false, value: "production" },
    { id: "c", key: "EMPTY", isSecret: false, value: "" }
];
const VALUES = { a: "postgres://u:p@db:5432/app", b: "production", c: "" };

describe("writing the variables out", () => {
    it("writes a .env with every value quoted, so it reads back exactly", () => {
        const text = renderRaw(draftEntries(ROWS, EMPTY_DRAFT, VALUES), "env");
        expect(text).toBe(
            'DATABASE_URL="postgres://u:p@db:5432/app"\nNODE_ENV="production"\nEMPTY=""\n'
        );
        const read = parseRaw(text, "env");
        expect(read).toEqual({
            ok: true,
            entries: [
                { key: "DATABASE_URL", value: "postgres://u:p@db:5432/app" },
                { key: "NODE_ENV", value: "production" },
                { key: "EMPTY", value: "" }
            ]
        });
    });

    it("keeps a value with quotes, a hash or spaces in it as it is", () => {
        const text = renderRaw([{ key: "GREETING", value: ' say "hi" # not a comment ' }], "env");
        expect(parseRaw(text, "env")).toEqual({
            ok: true,
            entries: [{ key: "GREETING", value: ' say "hi" # not a comment ' }]
        });
    });

    it("keeps a value of several lines, tabs and backslashes, on one line each way", () => {
        const pem = '-----BEGIN KEY-----\nabc\\def\r\n\tghi"\n-----END KEY-----\n';
        const entries = [
            { key: "PEM", value: pem },
            { key: "PATH_LIKE", value: "C:\\Users\\n" },
            { key: "AFTER", value: "x" }
        ];
        const text = renderRaw(entries, "env");
        expect(text.split("\n").filter(Boolean)).toHaveLength(3);
        expect(parseRaw(text, "env")).toEqual({ ok: true, entries });
        expect(parseRaw(renderRaw(entries, "json"), "json")).toEqual({ ok: true, entries });
    });

    it("writes JSON as one object of names to values", () => {
        expect(JSON.parse(renderRaw(draftEntries(ROWS, EMPTY_DRAFT, VALUES), "json"))).toEqual({
            DATABASE_URL: "postgres://u:p@db:5432/app",
            NODE_ENV: "production",
            EMPTY: ""
        });
    });
});

describe("reading it back", () => {
    it("reads JSON values that are text, and refuses anything else in words", () => {
        expect(parseRaw('{"A": "1", "B": ""}', "json")).toEqual({
            ok: true,
            entries: [
                { key: "A", value: "1" },
                { key: "B", value: "" }
            ]
        });
        expect(parseRaw('{"A": 1}', "json")).toEqual({ ok: false, error: "notText", key: "A" });
        expect(parseRaw("[1, 2]", "json")).toEqual({ ok: false, error: "notObject" });
        expect(parseRaw("{oops", "json")).toEqual({ ok: false, error: "unreadable" });
        expect(parseRaw('{"1BAD": "x"}', "json")).toEqual({ ok: false, error: "badKey", key: "1BAD" });
    });

    it("lets the last of a key written twice win, as a shell would", () => {
        expect(parseRaw('A="1"\nA="2"', "env")).toEqual({
            ok: true,
            entries: [{ key: "A", value: "2" }]
        });
    });
});

describe("what typing it back changes", () => {
    it("opens with the changes already staged, and keeps them all when nothing is typed", () => {
        const staged = {
            edits: { b: { value: "staging" }, a: { isSecret: false } },
            added: [{ tempId: "new-1", key: "PORT", value: "3000", isSecret: true }],
            removed: ["c"]
        };
        const entries = draftEntries(ROWS, staged, VALUES);
        expect(entries).toEqual([
            { key: "DATABASE_URL", value: "postgres://u:p@db:5432/app" },
            { key: "NODE_ENV", value: "staging" },
            { key: "PORT", value: "3000" }
        ]);
        const read = parseRaw(renderRaw(entries, "env"), "env");
        if (!read.ok) throw new Error("unreadable");
        const again = stageReplacement(ROWS, staged, read.entries, false, () => "new-2");
        expect(variableChanges(ROWS, again, VALUES)).toEqual(variableChanges(ROWS, staged, VALUES));
    });

    it("removes what was left out, changes what differs, adds what is new, and leaves the rest", () => {
        let n = 0;
        const draft = stageReplacement(
            ROWS,
            EMPTY_DRAFT,
            [
                { key: "DATABASE_URL", value: "postgres://u:p@db:5432/app" },
                { key: "NODE_ENV", value: "development" },
                { key: "PORT", value: "3000" }
            ],
            false,
            () => `new-${++n}`
        );
        expect(variableChanges(ROWS, draft, VALUES)).toEqual({
            set: [
                { key: "NODE_ENV", value: "development", isSecret: false },
                { key: "PORT", value: "3000", isSecret: false }
            ],
            secrecy: [],
            remove: ["c"]
        });
    });

    it("drops a new variable from an earlier paste that the new text no longer has", () => {
        const earlier = {
            ...EMPTY_DRAFT,
            added: [{ tempId: "new-1", key: "OLD", value: "x", isSecret: false }]
        };
        const draft = stageReplacement(ROWS, earlier, [], false, () => "new-2");
        expect(draft.added).toEqual([]);
        expect(draft.removed.sort()).toEqual(["a", "b", "c"]);
    });
});
