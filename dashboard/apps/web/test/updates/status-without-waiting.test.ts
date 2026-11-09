/**
 * Settings never waits on GitHub when it already knows the answer.
 *
 * The update check asks GitHub and the registry, which takes seconds. Settings
 * waited for it every ten minutes and after every restart - and an update is a
 * restart, so the screen people open to see an update land was the slow one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../src/lib/update-service";

const RUNNING = "1111111111111111111111111111111111111111";

async function load(settings: Map<string, string>, running = RUNNING) {
    vi.resetModules();
    vi.doMock("../../src/lib/update-source", () => ({ getUpdateSource: async () => "image" }));
    vi.doMock("@/lib/setting-store", () => ({
        getSetting: async (key: string) => settings.get(key) ?? null,
        setSetting: async (key: string, value: string | null) => {
            if (value === null) settings.delete(key);
            else settings.set(key, value);
        }
    }));
    vi.doMock("@polaris/config", () => ({
        loadEnv: () => ({
            POLARIS_REPO: "o/p",
            POLARIS_UPDATE_BRANCH: "main",
            POLARIS_BUILD_SHA: running,
            POLARIS_WEB_IMAGE: "ghcr.io/o/p",
            POLARIS_IMAGE_TAG: "latest"
        })
    }));
    vi.doMock("../../src/lib/registry", () => ({
        readPublishedImage: async () => ({ digest: "sha256:d", buildSha: RUNNING, createdAt: "2026-07-30T13:35:18Z" })
    }));
    const asked = vi.fn(async () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", asked);
    const service = await import("../../src/lib/update-service");
    return { service, asked };
}

const kept = (at: number, current = RUNNING.slice(0, 7)) =>
    JSON.stringify({
        at,
        status: { phase: "idle", current, latest: current, upToDate: true, checkedAt: "x" } as Partial<UpdateStatus>
    });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/setting-store");
    vi.doUnmock("@polaris/config");
    vi.doUnmock("../../src/lib/registry");
    vi.doUnmock("../../src/lib/update-source");
});

describe("the update status after a restart", () => {
    it("is the kept answer at once, and refreshed behind it when stale", async () => {
        const settings = new Map([["updates.lastStatus", kept(Date.now() - 60 * 60 * 1000)]]);
        const { service, asked } = await load(settings);
        let settled = false;
        const answer = service.getUpdateStatus().then((status) => {
            settled = true;
            return status;
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect((await answer).upToDate).toBe(true);
        expect(settled).toBe(true);
        // The refresh went out, but nobody waited for it.
        await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    });

    it("does not ask at all while the kept answer is fresh", async () => {
        const settings = new Map([["updates.lastStatus", kept(Date.now())]]);
        const { service, asked } = await load(settings);
        expect((await service.getUpdateStatus()).upToDate).toBe(true);
        expect(asked).not.toHaveBeenCalled();
    });

    it("ignores an answer kept by the build that ran before the update", async () => {
        const settings = new Map([["updates.lastStatus", kept(Date.now(), "0000000")]]);
        const { service, asked } = await load(settings);
        await service.getUpdateStatus();
        expect(asked).toHaveBeenCalled();
    });
});
