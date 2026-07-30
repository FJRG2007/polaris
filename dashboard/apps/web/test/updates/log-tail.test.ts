/**
 * The update-log tail. The settings page re-attaches to an update in flight after
 * a reload using `finished` and `updatedAt`, so the cases here are the ones that
 * would either hide a running update or, worse, make a finished log look live -
 * a completed log larger than one chunk reports `done: false` on the first poll
 * and would otherwise be mistaken for a run still in progress.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const directory = await mkdtemp(join(tmpdir(), "polaris-update-log-"));
const logPath = join(directory, "update.log");
process.env.POLARIS_UPDATE_LOG = logPath;

vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { isAdmin: true } }) }));

const { GET } = await import("../../src/app/api/updates/logs/route");
const { isRecentRun, isUpdateInFlight, RECENT_RUN_MS, STALE_LOG_MS } = await import("../../src/lib/update-log");
type UpdateLogTail = import("../../src/lib/update-log").UpdateLogTail;

async function tail(offset = 0): Promise<UpdateLogTail> {
    const response = await GET(new NextRequest(`http://localhost/api/updates/logs?offset=${offset}`));
    return (await response.json()) as UpdateLogTail;
}

beforeEach(async () => {
    await rm(logPath, { force: true });
});

afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe("update log tail", () => {
    it("reports no log when the updater has never run", async () => {
        const result = await tail();
        expect(result.exists).toBe(false);
        expect(result.finished).toBe(false);
        expect(result.updatedAt).toBe(0);
    });

    it("streams a run in progress and marks it unfinished", async () => {
        await writeFile(logPath, "pulling image...\n");
        const result = await tail();
        expect(result.exists).toBe(true);
        expect(result.content).toBe("pulling image...\n");
        expect(result.finished).toBe(false);
        expect(result.done).toBe(false);
        expect(result.updatedAt).toBeGreaterThan(0);
    });

    it("reports the exit code once the updater writes its marker", async () => {
        await writeFile(logPath, "done\nPOLARIS_UPDATE_EXIT=0\n");
        const result = await tail();
        expect(result.finished).toBe(true);
        expect(result.done).toBe(true);
        expect(result.exitCode).toBe(0);
    });

    it("carries a failed run's exit code", async () => {
        await writeFile(logPath, "boom\nPOLARIS_UPDATE_EXIT=1\n");
        const result = await tail();
        expect(result.finished).toBe(true);
        expect(result.exitCode).toBe(1);
    });

    it("marks a finished log as finished even when it takes several polls to read", async () => {
        // Larger than the per-poll chunk, so the first response cannot be `done`.
        await writeFile(logPath, `${"step\n".repeat(40_000)}POLARIS_UPDATE_EXIT=0\n`);
        const first = await tail();
        expect(first.done).toBe(false);
        expect(first.finished).toBe(true); // the resume check relies on this
        const second = await tail(first.nextOffset);
        expect(second.finished).toBe(true);
    });

    it("restarts from the beginning when a new run truncates the file", async () => {
        await writeFile(logPath, "short\n");
        const result = await tail(9999);
        expect(result.content).toBe("short\n");
        expect(result.nextOffset).toBe(6);
    });
});

/** Fed with what the route actually returns, so the page's re-attach decision is
 *  tested against real responses rather than a hand-written stand-in. */
describe("re-attaching after a reload", () => {
    it("re-attaches to a run that is still being written", async () => {
        await writeFile(logPath, "pulling image...\n");
        expect(isUpdateInFlight(await tail(), Date.now())).toBe(true);
    });

    it("stays idle when no update has ever run", async () => {
        expect(isUpdateInFlight(await tail(), Date.now())).toBe(false);
    });

    it("stays idle on the log a finished update left behind", async () => {
        await writeFile(logPath, "done\nPOLARIS_UPDATE_EXIT=0\n");
        expect(isUpdateInFlight(await tail(), Date.now())).toBe(false);
    });

    it("stays idle on a long finished log the first poll cannot read to the end", async () => {
        // Without `finished` this would look live, re-attach, then reload the page
        // the moment the poll reached the marker - a reload loop on every visit.
        await writeFile(logPath, `${"step\n".repeat(40_000)}POLARIS_UPDATE_EXIT=0\n`);
        const first = await tail();
        expect(first.done).toBe(false);
        expect(isUpdateInFlight(first, Date.now())).toBe(false);
    });

    it("gives up on a crashed run whose log went quiet", async () => {
        await writeFile(logPath, "pulling image...\n");
        const result = await tail();
        expect(isUpdateInFlight(result, Date.now() + STALE_LOG_MS + 1000)).toBe(false);
    });

    it("carries the host's clock, so the age of a run never depends on the browser's", async () => {
        await writeFile(logPath, "pulling image...\n");
        const result = await tail();
        expect(result.now).toBeGreaterThan(0);
        expect(isUpdateInFlight(result, result.now)).toBe(true);
    });
});

/** A run that ended while the page was gone - the update restarts the web
 *  container, so this is the normal case, not the exception. */
describe("showing the run that just finished", () => {
    it("shows a run that has just ended", async () => {
        await writeFile(logPath, "done\nPOLARIS_UPDATE_EXIT=0\n");
        expect(isRecentRun(await tail(), Date.now())).toBe(true);
    });

    it("shows nothing when the updater has never run", async () => {
        expect(isRecentRun(await tail(), Date.now())).toBe(false);
    });

    it("drops a run old enough that the operator is no longer looking at it", async () => {
        await writeFile(logPath, "done\nPOLARIS_UPDATE_EXIT=0\n");
        const result = await tail();
        expect(isRecentRun(result, Date.now() + RECENT_RUN_MS + 1000)).toBe(false);
    });

    it("reports the exit code from the first poll, however little of the log it read", async () => {
        // Gated on `done`, this was null until the caller had walked the whole
        // file - so a page opening on a failed build could not tell it from a
        // live one, and offered neither the failure nor the report.
        await writeFile(logPath, `${"step\n".repeat(40_000)}POLARIS_UPDATE_EXIT=1\n`);
        const first = await tail();

        expect(first.done).toBe(false);
        expect(first.exitCode).toBe(1);
        expect(first.finished).toBe(true);
    });

    it("says how much there is, so the end can be asked for without walking to it", async () => {
        await writeFile(logPath, `${"step\n".repeat(40_000)}POLARIS_UPDATE_EXIT=1\n`);
        const first = await tail();
        expect(first.size).toBeGreaterThan(first.nextOffset);

        const end = await tail(first.size - 1024);
        expect(end.content).toContain("POLARIS_UPDATE_EXIT=1");
        expect(end.nextOffset).toBe(first.size);
    });

    it("leaves a run that reported no code without one, rather than calling it a success", async () => {
        // Quiet-but-live and cut-off look the same from here; the difference is
        // not the log's to invent.
        await writeFile(logPath, "pulling image...\n");
        const result = await tail();

        expect(result.finished).toBe(false);
        expect(result.exitCode).toBeNull();
        expect(isRecentRun(result, Date.now())).toBe(true);
    });
});
