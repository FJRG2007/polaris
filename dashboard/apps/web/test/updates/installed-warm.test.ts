/**
 * What the last update changed is read into the database before anybody opens
 * the Updates screen, so the first visit after an update does not wait on
 * GitHub. Asked again while GitHub is out of reach, and never once the row
 * holds it or the range is not known.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const installedUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/update-installed", () => ({ installedUpdate, recordInstallFrom: vi.fn() }));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_BUILD_SHA: "bbbbbbb" }),
    getCapabilities: () => ({})
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => [] }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchNotification: vi.fn() }));
vi.mock("@/lib/update-service", () => ({ getUpdateStatus: vi.fn() }));
vi.mock("@/lib/update-runner", () => ({}));

const changelog = { base: "aaaaaaa", head: "bbbbbbb", entries: [], url: "" };

beforeEach(() => {
    vi.resetModules();
    installedUpdate.mockReset();
});

async function warm() {
    const { warmInstalledChangelog } = await import("@/lib/update-watcher");
    return warmInstalledChangelog;
}

describe("the installed update's changelog", () => {
    it("is read for the running build and not asked again once kept", async () => {
        installedUpdate.mockResolvedValue({ from: "aaaaaaa", to: "bbbbbbb", changelog });
        const run = await warm();
        await run();
        await run();
        expect(installedUpdate).toHaveBeenCalledTimes(1);
        expect(installedUpdate).toHaveBeenCalledWith("bbbbbbb");
    });

    it("is asked again on the next pass while GitHub is out of reach", async () => {
        installedUpdate
            .mockResolvedValueOnce({ from: "aaaaaaa", to: "bbbbbbb", changelog: null })
            .mockResolvedValueOnce({ from: "aaaaaaa", to: "bbbbbbb", changelog });
        const run = await warm();
        await run();
        await run();
        await run();
        expect(installedUpdate).toHaveBeenCalledTimes(2);
    });

    it("is not asked at all again when the range is unknown", async () => {
        installedUpdate.mockResolvedValue({ from: null, to: "bbbbbbb", changelog: null });
        const run = await warm();
        await run();
        await run();
        expect(installedUpdate).toHaveBeenCalledTimes(1);
    });
});
