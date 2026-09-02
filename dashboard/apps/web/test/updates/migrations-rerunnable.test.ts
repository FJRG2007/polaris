/**
 * Every new migration has to survive being run twice.
 *
 * This exists because of what a half-applied migration costs. Postgres runs each
 * statement of a migration for real; if the fourth one fails, the first three
 * have already happened and are not rolled back. The history then records the
 * migration as failed, every later one is refused, and the update that ran it is
 * the last update that deployment can take - the entrypoint now says so by name
 * rather than dying quietly, but saying so is not the same as fixing it.
 *
 * A migration written so that each statement is a no-op when its object already
 * exists can be run again after the failure is cleared, and the second run
 * finishes what the first one started. That turns a dead deployment into a
 * retry, which is the difference between an operator pressing Update again and
 * an operator restoring a backup.
 *
 * The rule binds what is written from here on. The migrations already applied on
 * real installs are left exactly as they are: their text is checksummed, and
 * editing an applied migration is itself a way to stop a deployment updating.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

/** Everything named before this was written under the old rule and is applied on
 *  installs in the world. Nothing here may change them. */
const RULE_BINDS_FROM = "20261001000000";

const MIGRATIONS = join(process.cwd(), "..", "..", "packages", "db", "prisma", "migrations");

/** The forms Prisma emits that are not safe to run a second time, each with the
 *  spelling that is. Anything matching the left and missing the right is what a
 *  reader gets told about. */
const RULES: ReadonlyArray<{ readonly bad: RegExp; readonly want: string }> = [
    { bad: /CREATE TABLE\s+(?!IF NOT EXISTS)"/i, want: 'CREATE TABLE IF NOT EXISTS "…"' },
    { bad: /ADD COLUMN\s+(?!IF NOT EXISTS)"/i, want: 'ADD COLUMN IF NOT EXISTS "…"' },
    { bad: /CREATE(?:\s+UNIQUE)?\s+INDEX\s+(?!IF NOT EXISTS)"/i, want: 'CREATE INDEX IF NOT EXISTS "…"' },
    { bad: /DROP TABLE\s+(?!IF EXISTS)"/i, want: 'DROP TABLE IF EXISTS "…"' },
    { bad: /DROP COLUMN\s+(?!IF EXISTS)"/i, want: 'DROP COLUMN IF EXISTS "…"' },
    { bad: /DROP INDEX\s+(?!IF EXISTS)"/i, want: 'DROP INDEX IF EXISTS "…"' }
];

/** A constraint cannot be added conditionally, so the rerunnable spelling is to
 *  drop it first - which is what this looks for beside every ADD CONSTRAINT. */
const ADDS_CONSTRAINT = /ADD CONSTRAINT\s+"([^"]+)"/gi;

async function migrationsUnderTheRule(): Promise<string[]> {
    const entries = await readdir(MIGRATIONS, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory() && entry.name >= RULE_BINDS_FROM)
        .map((entry) => entry.name)
        .sort();
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
            const sql = statementsOf(await readFile(join(MIGRATIONS, name, "migration.sql"), "utf8"));
            for (const rule of RULES) {
                if (rule.bad.test(sql)) offences.push(`${name}: use ${rule.want}`);
            }
            for (const [, constraint] of sql.matchAll(ADDS_CONSTRAINT)) {
                // Adding a constraint twice is an error, and there is no
                // conditional form of it - so the rerunnable shape is to drop
                // the name first and add it back.
                if (!new RegExp(`DROP CONSTRAINT\\s+IF EXISTS\\s+"${constraint}"`, "i").test(sql)) {
                    offences.push(
                        `${name}: add DROP CONSTRAINT IF EXISTS "${constraint}" before adding it`
                    );
                }
            }
        }
        expect(offences).toEqual([]);
    });

    it("is measured against migrations that are actually there", async () => {
        // A rule that silently applies to nothing is a rule nobody is keeping,
        // and this one binds a folder by name - so the folder has to be the
        // right one. Every migration ever written is under it; the cutoff is
        // what narrows that to the new ones.
        const all = await readdir(MIGRATIONS, { withFileTypes: true });
        expect(all.filter((entry) => entry.isDirectory()).length).toBeGreaterThan(100);
    });
});
