/**
 * Moving the list of hosts: what a code taken in does to the kept list, which
 * page may ask, and the camera being the settings window's alone.
 */

import type { IpcHost } from "@/main/ipc";
import { CHANNELS } from "@/shared/bridge";
import type { SavedServer } from "@/shared/servers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));

vi.mock("electron", () => ({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    clipboard,
    dialog: {},
    app: { getPath: () => "", isPackaged: false, on: () => undefined },
    screen: {},
    desktopCapturer: {},
    session: {},
    shell: {},
    net: {},
    nativeImage: {},
    Notification: class {},
    safeStorage: {}
}));

const kinds = vi.hoisted(() => new Map<number, string>());
vi.mock("@/main/windows", () => ({
    kindOf: (sender: { id: number; }) => kinds.get(sender.id) ?? null,
    openPolarisWindow: vi.fn()
}));

const { copyHosts, importHosts } = await import("@/main/host-transfer");
const { allowLocalPermission } = await import("@/main/permissions");
const { encodeHostList } = await import("../../../dashboard/packages/core/src/host-list");

function event(kind: string) {
    const frame = { url: "file:///connect.html" };
    const sender = { id: kinds.size + 1, mainFrame: frame };
    kinds.set(sender.id, kind);
    return { sender, senderFrame: frame };
}

function store(initial: SavedServer[]) {
    let servers = initial;
    const keep = vi.fn((next: readonly SavedServer[]) => {
        servers = [...next];
    });
    return { saved: () => servers, keep, current: () => servers };
}

describe("a list taken in", () => {
    it("adds the new hosts after the kept ones and names an unnamed one", () => {
        const kept = store([
            { origin: "https://polaris.example.com", name: null },
            { origin: "https://mine.example.com", name: "Mine" }
        ]);
        const code = encodeHostList([
            { origin: "https://polaris.example.com", name: "Casa" },
            { origin: "https://mine.example.com", name: "Theirs" },
            { origin: "http://192.168.1.20:3000", name: null }
        ]);
        expect(importHosts(kept, code)).toEqual({ ok: true, added: 1, named: 1, skipped: 0 });
        expect(kept.current()).toEqual([
            { origin: "https://polaris.example.com", name: "Casa" },
            { origin: "https://mine.example.com", name: "Mine" },
            { origin: "http://192.168.1.20:3000", name: null }
        ]);
    });

    it("writes nothing when nothing changed, and refuses what is not a list", () => {
        const kept = store([{ origin: "https://polaris.example.com", name: "Casa" }]);
        expect(importHosts(kept, encodeHostList(kept.saved()))).toEqual({ ok: true, added: 0, named: 0, skipped: 0 });
        expect(importHosts(kept, "https://polaris.example.com")).toEqual({ ok: false, error: "That is not a list of Polaris hosts." });
        expect(kept.keep).not.toHaveBeenCalled();
    });

    it("counts the hosts that do not fit instead of dropping them silently", () => {
        const full = Array.from({ length: 20 }, (_, i) => ({ origin: `https://h${i}.example`, name: null }));
        const kept = store(full);
        const outcome = importHosts(kept, encodeHostList([{ origin: "https://new.example", name: null }]));
        expect(outcome).toEqual({ ok: true, added: 0, named: 0, skipped: 1 });
    });

    it("copies the list as a code", () => {
        const kept = store([{ origin: "https://polaris.example.com", name: "Casa" }]);
        expect(copyHosts(kept)).toEqual({ ok: true, count: 1 });
        expect(clipboard.writeText).toHaveBeenCalledWith(encodeHostList(kept.saved()));
    });
});

describe("at the door", () => {
    const hosts = {
        copy: vi.fn(() => ({ ok: true, count: 1 })),
        exportFile: vi.fn(async () => ({ ok: true, added: 0, named: 0, skipped: 0 })),
        importFile: vi.fn(async () => ({ ok: true, added: 0, named: 0, skipped: 0 })),
        take: vi.fn((_text: string) => ({ ok: true, added: 1, named: 0, skipped: 0 }))
    };

    beforeEach(async () => {
        handlers.clear();
        for (const one of Object.values(hosts)) one.mockClear();
        const { registerIpc } = await import("@/main/ipc");
        registerIpc({ server: () => "https://polaris.example.test", hosts } as unknown as IpcHost);
    });

    it("takes a code from the settings window", () => {
        handlers.get(CHANNELS.connectHostsImport)?.(event("connect"), "polaris-hosts:1:W10");
        expect(hosts.take).toHaveBeenCalledWith("polaris-hosts:1:W10");
    });

    it("refuses any other page, and anything but bounded text", () => {
        for (const [kind, raw] of [["polaris", "polaris-hosts:1:W10"], ["connect", 42], ["connect", "x".repeat(70_000)]] as const) {
            const outcome = handlers.get(CHANNELS.connectHostsImport)?.(event(kind), raw);
            expect(outcome).toMatchObject({ ok: false });
        }
        expect(handlers.get(CHANNELS.connectHostsCopy)?.(event("polaris"))).toEqual({ ok: false, count: 0 });
        expect(hosts.take).not.toHaveBeenCalled();
        expect(hosts.copy).not.toHaveBeenCalled();
    });
});

describe("the camera", () => {
    it("is the settings window's, for video only", () => {
        expect(allowLocalPermission("media", "connect", ["video"])).toBe(true);
        expect(allowLocalPermission("media", "connect", ["audio"])).toBe(false);
        expect(allowLocalPermission("media", "connect", ["video", "audio"])).toBe(false);
        expect(allowLocalPermission("media", "connect", [])).toBe(false);
        expect(allowLocalPermission("media", "polaris", ["video"])).toBe(false);
        expect(allowLocalPermission("notifications", "connect", undefined)).toBe(false);
    });
});
