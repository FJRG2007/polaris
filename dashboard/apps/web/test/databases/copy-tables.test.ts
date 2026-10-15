/**
 * Copying one database into another with some of its tables left behind.
 *
 * The dump command is the whole feature: a flag in the wrong place copies the
 * table anyway, and a routine dumped twice fails the load halfway.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

const MYSQL_BASE = ["mysqldump", "--single-transaction", "--routines", "--triggers", "-uapp", "-psecret", "shop"];

describe("filteredDumpArgv", () => {
    it("leaves the command alone when nothing is chosen", () => {
        expect(core.filteredDumpArgv("postgres", "shop", ["pg_dump", "-d", "shop"], undefined)).toEqual({
            main: ["pg_dump", "-d", "shop"],
            schemaPass: null
        });
        expect(
            core.filteredDumpArgv("mysql", "shop", MYSQL_BASE, { skip: [], structureOnly: [] })
        ).toEqual({ main: MYSQL_BASE, schemaPass: null });
    });

    it("excludes Postgres tables and their data with exact-case patterns", () => {
        const { main, schemaPass } = core.filteredDumpArgv("postgres", "shop", ["pg_dump", "-d", "shop"], {
            skip: ["Audit"],
            structureOnly: ["public.sessions"]
        });
        expect(main).toEqual([
            "pg_dump",
            "-d",
            "shop",
            '--exclude-table="Audit"',
            '--exclude-table-data="public"."sessions"'
        ]);
        expect(schemaPass).toBeNull();
    });

    it("ignores MySQL tables before the database name and dumps empty ones' structure in a second pass", () => {
        const { main, schemaPass } = core.filteredDumpArgv("mysql", "shop", MYSQL_BASE, {
            skip: ["audit"],
            structureOnly: ["sessions", "jobs"]
        });
        expect(main.at(-1)).toBe("shop");
        expect(main).toContain("--ignore-table=shop.audit");
        expect(main).toContain("--ignore-table=shop.sessions");
        expect(main).toContain("--ignore-table=shop.jobs");
        expect(schemaPass).not.toBeNull();
        expect(schemaPass).toContain("--no-data");
        // Routines were written by the first pass; a second copy fails the load.
        expect(schemaPass).not.toContain("--routines");
        expect(schemaPass!.slice(-3)).toEqual(["shop", "sessions", "jobs"]);
        expect(schemaPass!.indexOf("--no-data")).toBeLessThan(schemaPass!.indexOf("shop"));
    });

    it("has no second pass for MariaDB when nothing is copied empty", () => {
        const base = MYSQL_BASE.map((arg) => (arg === "mysqldump" ? "mariadb-dump" : arg));
        const { schemaPass } = core.filteredDumpArgv("mariadb", "shop", base, {
            skip: ["audit"],
            structureOnly: []
        });
        expect(schemaPass).toBeNull();
    });

    it("leaves MongoDB collections out by name", () => {
        const { main } = core.filteredDumpArgv("mongo", "shop", ["mongodump", "--db=shop"], {
            skip: ["events"],
            structureOnly: ["sessions"]
        });
        expect(main).toEqual([
            "mongodump",
            "--db=shop",
            "--excludeCollection=events",
            "--excludeCollection=sessions"
        ]);
    });
});

describe("copyTablesSchema", () => {
    it("accepts bare and schema-qualified names", () => {
        expect(core.copyTablesSchema.safeParse({ skip: ["users", "public.audit_log"] }).success).toBe(true);
    });

    it("refuses anything that could reach a shell or a pattern", () => {
        for (const name of ["a;b", "x y", "t*", "$(id)", "a.b.c", "1table", ""]) {
            expect(core.copyTablesSchema.safeParse({ skip: [name] }).success, name).toBe(false);
        }
    });

    it("refuses a table both left out and copied empty", () => {
        expect(core.copyTablesSchema.safeParse({ skip: ["a"], structureOnly: ["a"] }).success).toBe(false);
    });

    it("refuses tables for a source that is not a managed database", () => {
        const base = { databaseId: "00000000-0000-4000-8000-000000000001" };
        expect(
            core.databaseCopySchema.safeParse({
                ...base,
                fromUrl: "postgresql://u:p@h:5432/d",
                tables: { skip: ["a"], structureOnly: [] }
            }).success
        ).toBe(false);
        expect(
            core.databaseCopySchema.safeParse({
                ...base,
                fromDatabaseId: "00000000-0000-4000-8000-000000000002",
                tables: { skip: ["a"], structureOnly: [] }
            }).success
        ).toBe(true);
    });

    it("splits a typed list on commas, spaces and lines, once each", () => {
        expect(core.parseTableList(" a, b\nc  a,,")).toEqual(["a", "b", "c"]);
    });
});
