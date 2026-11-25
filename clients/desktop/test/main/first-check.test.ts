/**
 * The check a start makes: it says at once whether an update is going in, and
 * whether it finished, so the app can update before it opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    fetch: vi.fn(),
    listeners: new Map<string, (...args: unknown[]) => void>(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn()
}));

vi.mock("electron", () => ({
    app: { isPackaged: true, getVersion: () => "0.1.1", getPath: () => "C:/temp", on: () => undefined },
    powerMonitor: { on: () => undefined },
    net: { fetch: electron.fetch },
    autoUpdater: {
        on: (name: string, listener: (...args: unknown[]) => void) => electron.listeners.set(name, listener),
        setFeedURL: electron.setFeedURL,
        checkForUpdates: electron.checkForUpdates,
        quitAndInstall: electron.quitAndInstall
    }
}));
vi.mock("node:fs", async (actual) => ({ ...(await actual<object>()), existsSync: () => true }));
vi.mock("../../src/main/mac-signature", () => ({ developerSigned: async () => true }));
const setup = vi.hoisted(() => ({ downloadSetup: vi.fn() }));
vi.mock("../../src/main/setup-install", async (actual) => ({ ...(await actual<object>()), downloadSetup: setup.downloadSetup }));

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

    it("makes the release's installer the restart when Squirrel could not apply it", async () => {
        setup.downloadSetup.mockResolvedValue("C:/temp/polaris-setup-x/Polaris-Setup.exe");
        answers([release("desktop-v0.1.3")]);
        const found = vi.fn();
        const failed = vi.fn();
        const first = watchForUpdates(found, failed);
        await first.installing;
        electron.listeners.get("error")?.(new Error("locked"));
        await vi.waitFor(() => expect(found).toHaveBeenCalledTimes(1));
        expect(found.mock.calls[0]?.[0]).toMatchObject({ version: "0.1.3", restart: expect.any(Function) });
        expect(failed).not.toHaveBeenCalled();
    });

    it("hands it to the antivirus notice, once, with the reason, when the installer fails too", async () => {
        setup.downloadSetup.mockRejectedValue(new Error("SHA256SUMS does not list Polaris-Setup.exe"));
        answers([release("desktop-v0.1.3")]);
        const found = vi.fn();
        const failed = vi.fn();
        const first = watchForUpdates(found, failed);
        await first.installing;
        electron.listeners.get("error")?.(new Error("locked"));
        await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
        expect(failed.mock.calls[0]?.[0]).toMatchObject({ version: "0.1.3" });
        expect(failed.mock.calls[0]?.[1]?.reason).toMatch(/locked.*does not list/);
        expect(found).not.toHaveBeenCalled();
        electron.listeners.get("error")?.(new Error("locked"));
        await Promise.resolve();
        expect(failed).toHaveBeenCalledTimes(1);
    });

    it("treats Squirrel finding nothing, after a newer release was listed, as a failure on Windows", async () => {
        setup.downloadSetup.mockRejectedValue(new Error("offline"));
        answers([release("desktop-v0.1.3")]);
        const failed = vi.fn();
        const first = watchForUpdates(vi.fn(), failed);
        await first.installing;
        electron.listeners.get("update-not-available")?.();
        await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
        expect(failed.mock.calls[0]?.[1]?.reason).toMatch(/nothing to install/);
    });

    it("leaves the antivirus out off Windows", async () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        answers([release("desktop-v0.1.3")]);
        const failed = vi.fn();
        const first = watchForUpdates(vi.fn(), failed);
        await first.installing;
        electron.listeners.get("error")?.();
        expect(failed).not.toHaveBeenCalled();
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
