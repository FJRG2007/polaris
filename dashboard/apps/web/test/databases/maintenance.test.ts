/**
 * Vacuum and extensions: a name is looked up with bound values first, and only
 * a name the server itself listed is quoted into the statement that acts.
 */

import type { Run } from "@/lib/data/health";
import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/lib/data/driver";
import { installExtension, uninstallExtension, vacuumTable } from "@/lib/data/maintenance";

interface Call {
    statement: string;
    params?: readonly unknown[];
}

function fake(found: boolean): Run & { calls: Call[] } {
    const calls: Call[] = [];
    const run = (async (statement: string, params?: readonly unknown[]) => {
        calls.push({ statement, params });
        const rows = /^SELECT/.test(statement) && found ? [["x"]] : [];
        return [{ statement, columns: ["name"], rows, affected: null, ms: 0 }] as QueryResult[];
    }) as Run & { calls: Call[] };
    run.calls = calls;
    return run;
}

describe("installing an extension", () => {
    it("checks the server's own list with a bound value, then quotes the name", async () => {
        const run = fake(true);
        await installExtension(run, "uuid-ossp");
        expect(run.calls[0]).toEqual({ statement: "SELECT name FROM pg_available_extensions WHERE name = $1", params: ["uuid-ossp"] });
        expect(run.calls[1]?.statement).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    });

    it("refuses a name the server does not ship, before anything runs", async () => {
        const run = fake(false);
        await expect(installExtension(run, 'x"; DROP SCHEMA public CASCADE; --')).rejects.toThrow(
            "This server does not ship that extension."
        );
        expect(run.calls).toHaveLength(1);
    });
});

describe("removing an extension", () => {
    it("never cascades, and keeps plpgsql", async () => {
        const run = fake(true);
        await uninstallExtension(run, "hstore");
        expect(run.calls[1]?.statement).toBe('DROP EXTENSION IF EXISTS "hstore"');
        await expect(uninstallExtension(fake(true), "plpgsql")).rejects.toThrow(/part of the database/);
        await expect(uninstallExtension(fake(false), "hstore")).rejects.toThrow("That extension is not installed here.");
    });
});

describe("vacuuming a table", () => {
    it("finds the table by bound schema and name, then vacuums it quoted with room past the browsing timeout, never FULL", async () => {
        const run = fake(true);
        await vacuumTable(run, "public", 'we"ird');
        expect(run.calls[0]?.params).toEqual(["public", 'we"ird']);
        expect(run.calls[1]?.statement).toBe("SET statement_timeout = 1800000");
        expect(run.calls[2]?.statement).toBe('VACUUM (ANALYZE) "public"."we""ird"');
        await expect(vacuumTable(fake(false), "public", "missing")).rejects.toThrow("There is nothing here by that name.");
    });
});
