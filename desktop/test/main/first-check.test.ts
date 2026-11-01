/**
 * The check a start makes: it says at once whether an update is going in, and
 * whether it finished, so the app can update before it opens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    fetch: vi.fn(),
    listeners: new Map<string, () => void>(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn()
}));

vi.mock("electron", () => ({
    app: { isPackaged: true, getVersion: () => "0.1.1" },
    net: { fetch: electron.fetch },
    autoUpdater: {
        on: (name: string, listener: () => void) => electron.listeners.set(name, listener),
        setFeedURL: electron.setFeedURL,
        checkForUpdates: electron.checkForUpdates,
        quitAndInstall: electron.quitAndInstall
    }
}));
vi.mock("node:fs", async (actual) => ({ ...(await actual<object>()), existsSync: () => true }));
vi.mock("../../src/main/mac-signature", () => ({ developerSigned: async () => true }));

const { watchForUpdates } = await import("../../src/main/updates");

const release = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false, assets: [] });
const answers = (body: unknown) => electron.fetch.mockResolvedValue({ ok: true, json: async () => body });

beforeEach(() => {
    electron.fetch.mockReset();
    electron.listeners.clear();
    vi.clearAllMocks();
});

describe("the first check of a start", () => {
    it("says an update is going in, and when it is ready", async () => {
        answers([release("desktop-v0.1.3")]);
        const found = vi.fn();
        const first = watchForUpdates(found);
        expect(await first.installing).toBe(true);
        expect(electron.checkForUpdates).toHaveBeenCalled();
        electron.listeners.get("update-downloaded")?.();
        expect(await first.installed).toBe(true);
        expect(found.mock.calls[0]?.[0]).toMatchObject({ version: "0.1.3" });
    });

    it("opens the app as it is when nothing is newer", async () => {
        answers([release("desktop-v0.1.1")]);
        expect(await watchForUpdates(vi.fn()).installing).toBe(false);
    });

    it("opens the app as it is with no network", async () => {
        electron.fetch.mockRejectedValue(new Error("offline"));
        expect(await watchForUpdates(vi.fn()).installing).toBe(false);
    });

    it("says so when the install fails", async () => {
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        await first.installing;
        electron.listeners.get("error")?.();
        expect(await first.installed).toBe(false);
    });
});
