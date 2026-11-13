/**
 * The check a start makes: it says at once whether an update is going in, and
 * whether it finished, so the app can update before it opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const platform = process.platform;
const argv = process.argv;

beforeEach(() => {
    electron.fetch.mockReset();
    electron.listeners.clear();
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "win32" });
});

afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    process.argv = argv;
    vi.useRealTimers();
});

describe("the first check of a start", () => {
    it("says an update is going in, and when it is ready", async () => {
        answers([release("desktop-v0.1.3")]);
        const found = vi.fn();
        const first = watchForUpdates(found);
        expect(await first.installing).toBe("0.1.3");
        expect(electron.checkForUpdates).toHaveBeenCalled();
        electron.listeners.get("update-downloaded")?.();
        expect(await first.installed).toBe(true);
        expect(found.mock.calls[0]?.[0]).toMatchObject({ version: "0.1.3" });
    });

    it("says nothing is going in when nothing is newer", async () => {
        answers([release("desktop-v0.1.1")]);
        expect(await watchForUpdates(vi.fn()).installing).toBeNull();
    });

    it("says nothing is going in with no network", async () => {
        electron.fetch.mockRejectedValue(new Error("offline"));
        expect(await watchForUpdates(vi.fn()).installing).toBeNull();
    });

    it("waits out Squirrel's lock on the first launch after an install", async () => {
        vi.useFakeTimers();
        process.argv = [...argv, "--squirrel-firstrun"];
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        expect(await first.installing).toBeNull();
        expect(electron.fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(electron.fetch).toHaveBeenCalledTimes(1);
        expect(electron.checkForUpdates).toHaveBeenCalled();
    });

    it("says it has asked before the answer comes", async () => {
        electron.fetch.mockReturnValue(new Promise(() => undefined));
        await expect(watchForUpdates(vi.fn()).asked).resolves.toBeUndefined();
    });

    it("lets a press that found a download wait for it to be installed", async () => {
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        await first.installing;
        expect(await first.checkNow()).toEqual({ kind: "downloading", version: "0.1.3" });
        const ended = first.downloaded();
        let settled = false;
        void ended.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
        electron.listeners.get("update-downloaded")?.();
        expect(await ended).toEqual({ kind: "ready", version: "0.1.3" });
    });

    it("says the download page is the way when the download a press waits on fails", async () => {
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        await first.installing;
        const ended = first.downloaded();
        electron.listeners.get("error")?.();
        expect(await ended).toEqual({ kind: "available", version: "0.1.3" });
    });

    it("answers at once when the download ended before the press waited on it", async () => {
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        await first.installing;
        electron.listeners.get("update-downloaded")?.();
        expect(await first.downloaded()).toEqual({ kind: "ready", version: "0.1.3" });
    });

    it("says so when the install fails", async () => {
        answers([release("desktop-v0.1.3")]);
        const first = watchForUpdates(vi.fn());
        await first.installing;
        electron.listeners.get("error")?.();
        expect(await first.installed).toBe(false);
    });
});
