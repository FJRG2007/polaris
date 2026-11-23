/**
 * Several numbers per account. The migration only adds: the row an account
 * already has keeps its number and confirmation, gains an id, and becomes the
 * primary; at most one primary per account is held by a partial index.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
    join(process.cwd(), "../../packages/db/prisma/migrations/20271231000100_user_phones/migration.sql"),
    "utf8"
);
const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

describe("the user phones migration", () => {
    it("removes no row and no column", () => {
        expect(statements).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|DROP COLUMN|DROP TABLE/i);
    });

    it("backfills an id and makes the existing number the primary", () => {
        expect(statements).toMatch(/SET "id" = gen_random_uuid\(\) WHERE "id" IS NULL/);
        expect(statements).toMatch(/SET "primary" = true/);
        expect(statements).toMatch(/DISTINCT ON \("userId"\)/);
        // A second run leaves an account that already has a primary alone.
        expect(statements).toMatch(/AND NOT EXISTS \([\s\S]*"held"\."primary"/);
    });

    it("keeps one primary per account and one row per number per account", () => {
        expect(statements).toContain(
            'CREATE UNIQUE INDEX IF NOT EXISTS "UserPhone_userId_primary_key" ON "UserPhone"("userId") WHERE "primary"'
        );
        expect(statements).toContain('"UserPhone_userId_phone_key" ON "UserPhone"("userId", "phone")');
        expect(statements).toContain('ADD CONSTRAINT "UserPhone_pkey" PRIMARY KEY ("id")');
    });
});
