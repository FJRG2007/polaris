/**
 * The job table itself.
 *
 * Unlike the rest of these, this one really imports the module - which is the
 * point. Every job reaches into the service that owns the work, so this is what
 * catches an import that only fails when something actually loads it: a cycle, a
 * module that reads configuration as it is imported, a path that survives the
 * type checker because nothing on the running server ever pulled it in.
 */

import { describe, expect, it, vi } from "vitest";

// Reaching the services reaches the auth module, which reads configuration as it
// is imported. A running server has all of this; a test process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: async () => [] },
        protectedResource: { findMany: async () => [] },
        setting: { create: async () => ({}), updateMany: async () => ({ count: 0 }) }
    }
}));

const { SCHEDULED_JOBS } = await import("../../src/lib/cron/jobs");

describe("the work Polaris runs on a schedule", () => {
    it("loads at all, with every service behind it", () => {
        expect(SCHEDULED_JOBS.length).toBeGreaterThanOrEqual(6);
    });

    it("names each job once", () => {
        const keys = SCHEDULED_JOBS.map((job) => job.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("gives each one a cadence and something to run", () => {
        for (const job of SCHEDULED_JOBS) {
            expect(job.everyMs).toBeGreaterThan(0);
            expect(typeof job.run).toBe("function");
        }
    });

    it("leases the ones where a second runner would cost something", () => {
        // Backups would take a second copy of the same world; reminders would send
        // somebody the same notification twice; the health pass would stop a
        // server twice and tell its owner twice; the schedule pass now also writes
        // down who was playing, and two runners open a second visit for everybody
        // already on. The rest are written to be re-run and several already are,
        // from the screens that sweep them lazily.
        const leased = SCHEDULED_JOBS.filter((job) => job.leaseMs !== null).map((job) => job.key);
        expect(leased.sort()).toEqual(["backups", "game-health", "game-schedules", "task-reminders"]);
    });

    it("holds a lease for longer than the pass that takes it could run", () => {
        for (const job of SCHEDULED_JOBS) {
            if (job.leaseMs === null) continue;
            expect(job.leaseMs).toBeGreaterThan(job.everyMs);
        }
    });
});
