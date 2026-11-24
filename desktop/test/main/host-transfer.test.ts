/**
 * Moving the list of hosts: what a code taken in does to the kept list, which
 * page may ask: Settings > This app > Hosts on the host in use, and nothing else.
 */

import type { IpcHost } from "@/main/ipc";
import { CHANNELS } from "@/shared/bridge";
import type { SavedServer } from "@/shared/servers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));
const electronWebContents = vi.hoisted(() => ({ getAllWebContents: vi.fn((): unknown[] => []) }));

vi.mock("electron", () => ({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler), on: () => undefined },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    clipboard,
    webContents: electronWebContents,
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

describe("at the door: Settings > This app > Hosts", () => {
    const ORIGIN = "https://polaris.example.test";
    const OUTCOME_OK = { ok: true } as const;
    const hosts = {
        link: vi.fn(() => "polaris://hosts?list=x"),
        copy: vi.fn(() => ({ ok: true, count: 1 })),
        exportFile: vi.fn(async () => ({ ok: true, added: 0, named: 0, skipped: 0 })),
        importFile: vi.fn(async () => ({ ok: true, added: 1, named: 0, skipped: 0 })),
        take: vi.fn((_text: string) => ({ ok: true, added: 1, named: 0, skipped: 0 }))
    };
    const host = {
        server: () => ORIGIN,
        hosts,
        connectState: vi.fn(() => ({
            address: ORIGIN,
            error: null,
            servers: [{ origin: ORIGIN, name: "Casa", host: "polaris.example.test", active: true }],
            settings: { reason: null }
        })),
        connectCheck: vi.fn(async () => ({ ok: true, message: "Found it." })),
        addServer: vi.fn(async () => OUTCOME_OK),
        switchServer: vi.fn(async () => OUTCOME_OK),
        editServer: vi.fn(async () => OUTCOME_OK),
        removeServer: vi.fn(() => OUTCOME_OK),
        hostStatus: vi.fn(async () => "online" as const),
        manageHosts: vi.fn(),
        settingsAnnounced: vi.fn()
    };

    /** A page: by default the Polaris window's main frame on the host in use. */
    function page(kind = "polaris", url = `${ORIGIN}/account/app/hosts`, mainFrame = true) {
        const frame = { url };
        const sender = { id: kinds.size + 1, mainFrame: mainFrame ? frame : { url }, send: vi.fn() };
        kinds.set(sender.id, kind);
        return { sender, senderFrame: frame };
    }
    const call = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)?.(event, ...args);

    beforeEach(async () => {
        handlers.clear();
        for (const one of [...Object.values(hosts), ...Object.values(host)]) if (vi.isMockFunction(one)) one.mockClear();
        const { registerIpc } = await import("@/main/ipc");
        registerIpc(host as unknown as IpcHost);
    });

    it("lists the hosts with which one is in use and why it would not open", () => {
        expect(call(CHANNELS.hostsList, page())).toEqual({
            servers: [{ origin: ORIGIN, name: "Casa", host: "polaris.example.test", active: true }],
            error: null
        });
    });

    it("hands each change to the app, a listed host in its stored form", async () => {
        await call(CHANNELS.hostsAdd, page(), { address: "work.example.com", name: "Work" });
        expect(host.addServer).toHaveBeenCalledWith("work.example.com", "Work");
        await call(CHANNELS.hostsSwitch, page(), "HTTPS://Polaris.Example.Test/");
        expect(host.switchServer).toHaveBeenCalledWith(ORIGIN);
        await call(CHANNELS.hostsEdit, page(), { origin: ORIGIN, address: "https://new.example.com", name: "" });
        expect(host.editServer).toHaveBeenCalledWith(ORIGIN, "https://new.example.com", "");
        await call(CHANNELS.hostsRemove, page(), ORIGIN);
        expect(host.removeServer).toHaveBeenCalledWith(ORIGIN);
        expect(await call(CHANNELS.hostsStatus, page(), ORIGIN)).toBe("online");
        expect(await call(CHANNELS.hostsCheck, page(), "work.example.com")).toEqual({ ok: true, message: "Found it." });
        expect(call(CHANNELS.hostsLink, page())).toBe("polaris://hosts?list=x");
        expect(call(CHANNELS.hostsCopy, page())).toEqual({ ok: true, count: 1 });
        call(CHANNELS.hostsImport, page(), "polaris-hosts:1:W10");
        expect(hosts.take).toHaveBeenCalledWith("polaris-hosts:1:W10");
    });

    it("tells every Polaris page a change happened, so another window redraws", async () => {
        const watcher = { id: 900, send: vi.fn() };
        kinds.set(900, "polaris");
        electronWebContents.getAllWebContents.mockReturnValue([watcher]);
        await call(CHANNELS.hostsAdd, page(), { address: "work.example.com", name: "" });
        expect(watcher.send).toHaveBeenCalledWith(CHANNELS.appSettingsChanged);
        electronWebContents.getAllWebContents.mockReturnValue([]);
    });

    it("refuses the hosts window, another origin, a subframe, and malformed input", async () => {
        const strangers = [page("connect", "file:///connect.html"), page("polaris", "https://evil.example/account"), page("polaris", `${ORIGIN}/x`, false)];
        for (const stranger of strangers) {
            expect(call(CHANNELS.hostsList, stranger)).toBeNull();
            expect(await call(CHANNELS.hostsAdd, stranger, { address: "work.example.com", name: "" })).toMatchObject({ ok: false });
            expect(await call(CHANNELS.hostsRemove, stranger, ORIGIN)).toMatchObject({ ok: false });
            expect(await call(CHANNELS.hostsImport, stranger, "polaris-hosts:1:W10")).toMatchObject({ ok: false });
            expect(call(CHANNELS.hostsCopy, stranger)).toEqual({ ok: false, count: 0 });
            expect(call(CHANNELS.hostsLink, stranger)).toBe("");
            expect(await call(CHANNELS.hostsStatus, stranger, ORIGIN)).toBe("unknown");
        }
        expect(await call(CHANNELS.hostsAdd, page(), { address: 42, name: "" })).toMatchObject({ ok: false });
        expect(await call(CHANNELS.hostsRemove, page(), "not an address")).toMatchObject({ ok: false });
        expect(await call(CHANNELS.hostsImport, page(), "x".repeat(70_000))).toMatchObject({ ok: false });
        expect(host.addServer).not.toHaveBeenCalled();
        expect(host.removeServer).not.toHaveBeenCalled();
        expect(hosts.take).not.toHaveBeenCalled();
    });

    it("sends Hosts > Manage and the account menu's hosts to the app's one decision, for the page that asked", () => {
        const asker = page();
        call(CHANNELS.appSettingsHosts, asker);
        call(CHANNELS.openServers, asker);
        expect(host.manageHosts).toHaveBeenNthCalledWith(1, asker.sender);
        expect(host.manageHosts).toHaveBeenNthCalledWith(2, asker.sender);
        call(CHANNELS.appSettingsHosts, page("connect", "file:///connect.html"));
        expect(host.manageHosts).toHaveBeenCalledTimes(2);
    });

    it("hears whether the page draws the hosts; an older page sends nothing and does not", () => {
        const current = page();
        call(CHANNELS.appSettingsAnnounce, current, ["hosts"]);
        expect(host.settingsAnnounced).toHaveBeenLastCalledWith(current.sender, true);
        const older = page();
        call(CHANNELS.appSettingsAnnounce, older);
        expect(host.settingsAnnounced).toHaveBeenLastCalledWith(older.sender, false);
        call(CHANNELS.appSettingsAnnounce, page(), "hosts");
        expect(host.settingsAnnounced).toHaveBeenLastCalledWith(expect.anything(), false);
    });

    it("keeps no channel for the hosts window to edit, remove or move the list: that is Settings now", () => {
        for (const gone of ["connectRename", "connectEdit", "connectRemove", "connectHostsCopy", "connectHostsExport", "connectHostsOpen", "connectHostsImport"]) {
            expect(gone in CHANNELS).toBe(false);
        }
    });
});
