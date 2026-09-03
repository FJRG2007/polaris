/**
 * Every new migration has to survive being run twice.
 *
 * This exists because of what a half-applied migration costs. Postgres runs each
 * statement of a migration for real; if the fourth one fails, the first three
 * have already happened and are not rolled back. The history then records the
 * migration as failed, and every later one is refused.
 *
 * A migration written so that each statement is a no-op when its object already
 * exists can be run again after the failure is cleared, and the second run
 * finishes what the first one started. That is what the entrypoint relies on: it
 * clears the failed row itself and runs the migration once more, but only for
 * migrations this rule covers, so what the rule lets through is what a
 * deployment will re-run unattended.
 *
 * The rule binds what is written from here on. The migrations already applied on
 * real installs are left exactly as they are: their text is checksummed, and
 * editing an applied migration is itself a way to stop a deployment updating.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

/** Everything named before this was written under the old rule and is applied on
 *  installs in the world. Nothing here may change them. It sits one second past
 *  the newest migration that has shipped, so everything written next is covered
 *  and nothing already applied is. */
const RULE_BINDS_FROM = "20260930110001";

const MIGRATIONS = join(process.cwd(), "..", "..", "packages", "db", "prisma", "migrations");

const ENTRYPOINT = join(process.cwd(), "..", "..", "docker", "entrypoint.sh");

/** The forms Prisma emits that are not safe to run a second time, each with the
 *  spelling that is. Anything matching the left and missing the right is what a
 *  reader gets told about. */
const RULES: ReadonlyArray<{ readonly bad: RegExp; readonly want: string }> = [
    { bad: /CREATE TABLE\s+(?!IF NOT EXISTS)"/i, want: 'CREATE TABLE IF NOT EXISTS "…"' },
    { bad: /ADD COLUMN\s+(?!IF NOT EXISTS)"/i, want: 'ADD COLUMN IF NOT EXISTS "…"' },
    {
        bad: /CREATE(?:\s+UNIQUE)?\s+INDEX\s+(?!IF NOT EXISTS)"/i,
        want: 'CREATE INDEX IF NOT EXISTS "…"'
    },
    { bad: /DROP TABLE\s+(?!IF EXISTS)"/i, want: 'DROP TABLE IF EXISTS "…"' },
    { bad: /DROP COLUMN\s+(?!IF EXISTS)"/i, want: 'DROP COLUMN IF EXISTS "…"' },
    { bad: /DROP INDEX\s+(?!IF EXISTS)"/i, want: 'DROP INDEX IF EXISTS "…"' },
    // The one Prisma writes most often: every foreign-key change drops the old
    // constraint by name first, and that statement is an error the second time.
    { bad: /DROP CONSTRAINT\s+(?!IF EXISTS)"/i, want: 'DROP CONSTRAINT IF EXISTS "…"' }
];

/** A constraint cannot be added conditionally, so the rerunnable spelling is to
 *  drop it first - which is what this looks for beside every ADD CONSTRAINT. */
const ADDS_CONSTRAINT = /ADD CONSTRAINT\s+"([^"]+)"/gi;

/** A backfill is not DDL, so no IF NOT EXISTS covers it: run the same INSERT
 *  twice and the rows are simply there twice. */
const INSERTS = /INSERT\s+INTO/i;
const INSERTS_ONCE = /ON CONFLICT|WHERE NOT EXISTS/i;

async function migrationDirectories(): Promise<string[]> {
    const entries = await readdir(MIGRATIONS, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

async function migrationsUnderTheRule(): Promise<string[]> {
    return (await migrationDirectories()).filter((name) => name >= RULE_BINDS_FROM);
}

/** The 14-digit timestamp Prisma names a migration with. */
function stampOf(name: string): string {
    return name.slice(0, 14);
}

function quoted(identifier: string): string {
    return identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Comments carry example SQL and prose about what was dropped; neither is a
 *  statement Postgres will run. */
function statementsOf(sql: string): string {
    return sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
}

describe("a migration written from now on", () => {
    it("is rerunnable, so a failed one can be finished by trying again", async () => {
        const offences: string[] = [];
        for (const name of await migrationsUnderTheRule()) {
            const sql = statementsOf(
                await readFile(join(MIGRATIONS, name, "migration.sql"), "utf8")
            );
            for (const rule of RULES) {
                if (rule.bad.test(sql)) offences.push(`${name}: use ${rule.want}`);
            }
            for (const add of sql.matchAll(ADDS_CONSTRAINT)) {
                // Adding a constraint twice is an error, and there is no
                // conditional form of it - so the rerunnable shape is to drop
                // the name first and add it back. Before, not merely somewhere
                // in the file: a drop that comes after the add leaves the second
                // run failing on the add exactly as it would without one.
                const constraint = add[1] ?? "";
                const drop = new RegExp(
                    `DROP CONSTRAINT\\s+IF EXISTS\\s+"${quoted(constraint)}"`,
                    "i"
                ).exec(sql);
                if (drop === null || drop.index > add.index) {
                    offences.push(
                        `${name}: add DROP CONSTRAINT IF EXISTS "${constraint}" before adding it`
                    );
                }
            }
            for (const statement of sql.split(";")) {
                if (INSERTS.test(statement) && !INSERTS_ONCE.test(statement)) {
                    offences.push(
                        `${name}: an INSERT has to say ON CONFLICT DO NOTHING, or select WHERE NOT EXISTS - a second run duplicates its rows`
                    );
                }
            }
        }
        expect(offences).toEqual([]);
    });

    it("cannot be the next migration written, exempted by a cutoff in the future", async () => {
        // A rule that silently applies to nothing is a rule nobody is keeping.
        // It cannot cover anything already in the folder - those are applied and
        // checksummed on real installs - so what it has to guarantee instead is
        // that nothing written from now on falls outside it. One second past the
        // newest migration does that; a cutoff a month out exempts every
        // migration written in between, which is every migration this rule was
        // added for.
        const directories = await migrationDirectories();
        expect(directories.length).toBeGreaterThan(100);
        const newest = directories.map(stampOf).sort().at(-1);
        expect(newest).toBeDefined();
        expect(BigInt(RULE_BINDS_FROM)).toBeLessThanOrEqual(BigInt(newest!) + 1n);
    });

    it("is the same cutoff the entrypoint will retry a failed migration from", async () => {
        // The entrypoint clears the failed history row and runs the migration
        // again by itself, and it does that only for migrations this rule
        // covers. A different cutoff there means a deployment re-running a
        // migration nothing ever checked was safe to re-run.
        const entrypoint = await readFile(ENTRYPOINT, "utf8");
        expect(entrypoint).toMatch(new RegExp(`^RERUNNABLE_FROM=${RULE_BINDS_FROM}$`, "m"));
    });
});
