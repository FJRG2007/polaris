/**
 * Dependencies gained an order of their own on each task. Every link that
 * already exists has to keep the place it was shown in - the lists were read in
 * the order rows were written, so each is numbered by when it was linked - and a
 * second run of the migration must never renumber a list somebody has since
 * arranged by hand.
 */

import { join } from "node:path";
import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
    join(
        process.cwd(),
        "../../packages/db/prisma/migrations/20261231120000_task_dependency_order/migration.sql"
    ),
    "utf8"
);
const schema = readFileSync(join(process.cwd(), "../../packages/db/prisma/schema.prisma"), "utf8");

/** The statements, without the comments that explain them. */
const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

describe("the dependency order migration", () => {
    it("only adds: two columns and two indexes, nothing dropped or deleted", () => {
        expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "blockingOrder" DOUBLE PRECISION/);
        expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "waitingOrder" DOUBLE PRECISION/);
        expect(statements).toMatch(
            /CREATE INDEX IF NOT EXISTS "TaskDependency_blockerId_blockingOrder_idx"/
        );
        expect(statements).toMatch(
            /CREATE INDEX IF NOT EXISTS "TaskDependency_blockedId_waitingOrder_idx"/
        );
        expect(statements).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    });

    it("numbers each task's lists by when the link was made, spaced like every other order", () => {
        expect(statements).toContain(`SET "blockingOrder" = ranked.position * ${core.ORDER_STEP}`);
        expect(statements).toContain(`SET "waitingOrder" = ranked.position * ${core.ORDER_STEP}`);
        expect(statements).toContain(
            'ROW_NUMBER() OVER (PARTITION BY "blockerId" ORDER BY "createdAt", "id")'
        );
        expect(statements).toContain(
            'ROW_NUMBER() OVER (PARTITION BY "blockedId" ORDER BY "createdAt", "id")'
        );
    });

    it("never renumbers a key that is already set, so a rerun keeps a hand-made order", () => {
        expect(statements).toMatch(/edge\."blockingOrder" IS NULL/);
        expect(statements).toMatch(/edge\."waitingOrder" IS NULL/);
        // Backfilled before the columns stop accepting nulls, or the numbering
        // would have nothing left to find.
        expect(statements.indexOf('edge."waitingOrder" IS NULL')).toBeLessThan(
            statements.indexOf('ALTER COLUMN "waitingOrder" SET NOT NULL')
        );
    });

    it("ends with the columns the schema declares", () => {
        expect(statements).toContain(`ALTER COLUMN "blockingOrder" SET DEFAULT ${core.ORDER_STEP}`);
        expect(statements).toContain(`ALTER COLUMN "waitingOrder" SET DEFAULT ${core.ORDER_STEP}`);
        expect(statements).toContain('ALTER COLUMN "blockingOrder" SET NOT NULL');
        expect(statements).toContain('ALTER COLUMN "waitingOrder" SET NOT NULL');
        expect(schema).toMatch(
            new RegExp(`blockingOrder\\s+Float\\s+@default\\(${core.ORDER_STEP}\\)`)
        );
        expect(schema).toMatch(
            new RegExp(`waitingOrder\\s+Float\\s+@default\\(${core.ORDER_STEP}\\)`)
        );
    });
});
