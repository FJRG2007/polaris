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
        // already on. The two home passes write and delete footage: one would
        // record the same minutes twice, the other would race itself on a file
        // one of them had already dropped, and the availability pass would have
        // two runners each decide they were the one to write an outage down, so
        // the house is told twice that its cameras went dark. The connection
        // sweep announces that a
        // linked account has stopped working, and two runners would each announce
        // it before either wrote that it had been announced. The rest are written
        // to be re-run and several already are, from the screens that sweep them
        // lazily. A scheduled message is the plainest case of all: two runners
        // would send it twice, into a room, under somebody's name. A tracker pull
        // writes the link that stops an issue arriving twice AFTER it creates the
        // task, so two passes over one connection produce two of everything it
        // had not seen before.
        const leased = SCHEDULED_JOBS.filter((job) => job.leaseMs !== null).map((job) => job.key);
        expect(leased.sort()).toEqual([
            // Two runners tearing the same container down race each other onto
            // the same daemon call, and the one that loses fails on a container
            // the other already removed.
            "agent-housekeeping",
            "backups",
            "chat-scheduled",
            "connection-health",
            "game-health",
            "game-schedules",
            "home-availability",
            "home-recording",
            "home-retention",
            "host-space",
            "task-reminders",
            "task-trackers"
        ]);
    });

    it("holds a lease for longer than the pass that takes it could run", () => {
        for (const job of SCHEDULED_JOBS) {
            if (job.leaseMs === null) continue;
            expect(job.leaseMs).toBeGreaterThan(job.everyMs);
        }
    });
});
