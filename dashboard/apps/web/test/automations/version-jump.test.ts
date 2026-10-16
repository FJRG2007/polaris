/**
 * An install that skips versions: one boot applies every migration since the
 * one it had, in order, then runs the boot steps. Nothing may be lost and the
 * old automation tables must survive that boot whatever the release says.
 *
 * Postgres is not available here, so the migrations are checked for the
 * property that makes a single run over any earlier schema safe - every
 * statement idempotent, nothing dropped - and the boot is simulated against
 * the in-memory database with old rows present.
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createFakeDb } from "./fixtures/fake-prisma";

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeDb> | null }));
vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => ({ id: "u1", isAdmin: false }), mayAllowLocalNetwork: async () => false }));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response("{}") }));

const { runAutomationsPass } = await import("@/lib/automations/job");
const retirement = await import("@/lib/automations/legacy-retirement");

const MIGRATIONS = join(process.cwd(), "../../packages/db/prisma/migrations");
const ours = readdirSync(MIGRATIONS).filter((name) => /^2026123100027\d_automation/.test(name));
const sql = (name: string) =>
    readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

describe("an install that jumps several versions at once", () => {
    it("finds the automations migrations", () => expect(ours.length).toBeGreaterThanOrEqual(2));

    it.each(ours)("%s applies cleanly over any earlier schema and drops nothing", (name) => {
        const body = sql(name);
        expect(body).not.toMatch(/DROP\s+TABLE/i);
        expect(body).not.toMatch(/DROP\s+COLUMN/i);
        expect(body).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
        for (const statement of body.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(IF NOT EXISTS\s+)?\S+/gi) ?? [])
            expect(statement, statement).toMatch(/IF NOT EXISTS/i);
        for (const statement of body.match(/ADD\s+COLUMN\s+(IF NOT EXISTS\s+)?\S+/gi) ?? []) expect(statement).toMatch(/IF NOT EXISTS/i);
        for (const statement of body.match(/ADD\s+CONSTRAINT\s+"(\w+)"/gi) ?? []) {
            const constraint = /"(\w+)"/.exec(statement)![1];
            expect(body).toContain(`DROP CONSTRAINT IF EXISTS "${constraint}"`);
        }
    });

    it("keeps every old row and the old tables through the boot that moved them", async () => {
        const fake = db.current!;
        // Old rows as an old install has them.
        for (let i = 0; i < 3; i++) await fake.prisma.placeAutomation.create({ data: { name: `old ${i}` } });
        await runAutomationsPass();
        await runAutomationsPass();
        expect(fake.tables.placeAutomation).toHaveLength(3);
        const boots = Number(fake.tables.setting!.find((row) => row.key === retirement.ENGINE_BOOTS_KEY)!.value);
        expect(boots).toBe(1);

        // The move finished in this very boot: the tables must stay.
        const now = new Date();
        const sameBoot = { sourceRows: 3, movedRows: 3, oldRunsWaiting: 0, markerAt: now, bootsAtMarker: boots, boots, now };
        expect(retirement.legacyRetirementVerdict(sameBoot)).toEqual({ retire: false, reason: "tooSoon" });
        const later = new Date(now.getTime() + retirement.RETIRE_AFTER_MS + 1);
        expect(retirement.legacyRetirementVerdict({ ...sameBoot, now: later })).toEqual({ retire: false, reason: "noLaterBoot" });
        expect(retirement.legacyRetirementVerdict({ ...sameBoot, now: later, boots: boots + 1 })).toEqual({ retire: true });
    });

    it("keeps the tables while anything is left to move or drain", () => {
        const now = new Date();
        const base = { sourceRows: 3, movedRows: 3, oldRunsWaiting: 0, markerAt: new Date(0), bootsAtMarker: 1, boots: 5, now };
        expect(retirement.legacyRetirementVerdict({ ...base, movedRows: 2 })).toMatchObject({ reason: "rowsLeft" });
        expect(retirement.legacyRetirementVerdict({ ...base, oldRunsWaiting: 1 })).toMatchObject({ reason: "runsWaiting" });
        expect(retirement.legacyRetirementVerdict({ ...base, markerAt: null })).toMatchObject({ reason: "noMarker" });
    });
});
