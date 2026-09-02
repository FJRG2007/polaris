/**
 * Hiding what Postgres owns, without hiding anything else.
 *
 * Two bugs live here and both are silent, which is why this file exists rather
 * than a comment.
 *
 * **The list of system schemas cannot be a list.** `pg_temp_N` and
 * `pg_toast_temp_N` are created per backend as sessions make temporary tables,
 * so the set changes while somebody is looking at it. Naming three fixed schemas
 * and one of the two patterns is what shipped, and `pg_toast_temp_3` duly turned
 * up in the schema selector - and on a database with no `public`, could be the
 * one the browser opened on. The prefix is the rule; Postgres reserves it and
 * refuses to create a schema with it, so nothing of anybody's is hidden.
 *
 * **The escape is one backslash away from being a wildcard.** LIKE reads a bare
 * `_` as "any single character", so the pattern has to escape it - and written
 * inline in a template literal the backslash is dropped, turning `pg\_%` into
 * `pg_%` and quietly excluding `pgbouncer`, `pgq` and anything else beginning
 * "pg" plus a character. That is exactly what happened while this was being
 * written, which is why the pattern is now one exported value that both queries
 * interpolate.
 */

import { describe, expect, it } from "vitest";
import { POSTGRES_SYSTEM_SCHEMA_LIKE } from "@/lib/data/driver";

/**
 * LIKE, as Postgres reads it, for the small subset this pattern uses.
 *
 * Written out rather than approximated with a plain `startsWith`, because what is
 * being asserted is precisely the difference between an escaped underscore and
 * an unescaped one - and a test that could not tell them apart would pass on the
 * bug.
 */
function likeMatches(pattern: string, value: string): boolean {
    let expression = "";
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === "\\") {
            // Escaped: the next character is itself, whatever LIKE would
            // otherwise make of it.
            index += 1;
            expression += (pattern[index] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            continue;
        }
        if (character === "%") {
            expression += ".*";
            continue;
        }
        if (character === "_") {
            expression += ".";
            continue;
        }
        expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${expression}$`).test(value);
}

describe("the pattern itself", () => {
    it("escapes the underscore rather than leaving it as a wildcard", () => {
        // The whole bug, in one assertion: with the backslash lost this is
        // "pg" plus any character, and the two cases below swap answers.
        expect(POSTGRES_SYSTEM_SCHEMA_LIKE).toBe("pg\\_%");
    });
});

describe("what it hides", () => {
    it("hides the catalogues", () => {
        for (const schema of ["pg_catalog", "pg_toast"]) {
            expect(likeMatches(POSTGRES_SYSTEM_SCHEMA_LIKE, schema), schema).toBe(true);
        }
    });

    it("hides the per-session schemas a fixed list cannot name", () => {
        // The reported leak: pg_toast_temp_N was reaching the schema selector.
        for (const schema of ["pg_temp_1", "pg_temp_47", "pg_toast_temp_3"]) {
            expect(likeMatches(POSTGRES_SYSTEM_SCHEMA_LIKE, schema), schema).toBe(true);
        }
    });
});

describe("what it must not hide", () => {
    it("leaves a schema that merely starts with pg alone", () => {
        // These are the ones an unescaped underscore would take with it, and
        // nobody would notice until a schema went missing from the selector.
        for (const schema of ["pgbouncer", "pgq", "pgboss", "pgcrypto_stuff"]) {
            expect(likeMatches(POSTGRES_SYSTEM_SCHEMA_LIKE, schema), schema).toBe(false);
        }
    });

    it("leaves ordinary schemas alone", () => {
        for (const schema of ["public", "app", "tenant_4", "reporting"]) {
            expect(likeMatches(POSTGRES_SYSTEM_SCHEMA_LIKE, schema), schema).toBe(false);
        }
    });
});

describe("the LIKE reader these rest on", () => {
    it("tells an escaped underscore from a bare one", () => {
        // If this were wrong every assertion above would be worthless.
        expect(likeMatches("pg\\_%", "pg_temp_1")).toBe(true);
        expect(likeMatches("pg\\_%", "pgbouncer")).toBe(false);
        expect(likeMatches("pg_%", "pgbouncer")).toBe(true);
    });
});
