/**
 * A list of hosts taken in from another device, through the real worker: new
 * hosts are added after the ones already here, an unnamed host takes the name it
 * arrived with, anything that is not a list is refused without touching storage,
 * and the list never grows past the extension's cap.
 */

import { SERVERS_MAX } from "../src/lib/servers";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request } from "../src/lib/messages";
import { encodeHostList, hostListFile } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "https://home.example.com";
const WORK = "https://work.example.com";
const LAB = "https://lab.example.com";

async function ask(request: Request): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const held = await fakeBrowser.runtime.onMessage.trigger(
        request,
        { id: fakeBrowser.runtime.id },
        answer
    );
    expect(held).toContain(true);
    return replied;
}

async function stored(): Promise<unknown> {
    return (await fakeBrowser.storage.local.get("servers.list"))["servers.list"];
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    vi.stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    let requested = 0;
    (fakeBrowser as unknown as { permissions: unknown }).permissions = {
        contains: async () => true,
        request: async () => {
            requested++;
            return true;
        },
        getAll: async () => ({ origins: [], permissions: [] }),
        onAdded: { addListener() {} },
        onRemoved: { addListener() {} }
    };
    (globalThis as { requested?: () => number }).requested = () => requested;
    (fakeBrowser as unknown as { contextMenus: unknown }).contextMenus = {
        create() {},
        update: async () => {},
        removeAll: async () => {},
        onClicked: { addListener() {} }
    };
    (fakeBrowser as unknown as { scripting: unknown }).scripting = {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {}
    };
    await fakeBrowser.storage.local.set({
        "servers.list": [
            { origin: HOME, name: "Home" },
            { origin: WORK, name: null }
        ]
    });
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("taking in a list of hosts", () => {
    it("adds new hosts after the ones here, and names an unnamed one", async () => {
        const code = encodeHostList([
            { origin: HOME, name: "Somebody else's name" },
            { origin: WORK, name: "Work" },
            { origin: LAB, name: "Lab" }
        ]);
        const reply = await ask({ kind: "importHosts", text: code });
        expect(reply).toEqual({ ok: true, imported: { added: 1, named: 1, skipped: 0 } });
        expect(await stored()).toEqual([
            { origin: HOME, name: "Home" },
            { origin: WORK, name: "Work" },
            { origin: LAB, name: "Lab" }
        ]);
        // Nothing is asked of the browser: each host is granted on its switch.
        expect((globalThis as unknown as { requested: () => number }).requested()).toBe(0);
    });

    it("reads a file as well as a code", async () => {
        const reply = await ask({
            kind: "importHosts",
            text: hostListFile([{ origin: LAB, name: null }])
        });
        expect(reply).toEqual({ ok: true, imported: { added: 1, named: 0, skipped: 0 } });
    });

    it("refuses text that is not a list, and anything that is not text, writing nothing", async () => {
        const before = await stored();
        for (const text of ["hello", "polaris-hosts:1:!!!", "x".repeat(65_537), 42, null]) {
            const reply = await ask({ kind: "importHosts", text } as unknown as Request);
            expect(reply).toEqual({ ok: false, error: "That is not a list of Polaris hosts." });
        }
        expect(await stored()).toEqual(before);
    });

    it("stops at the cap and counts what was left out", async () => {
        const many = Array.from({ length: SERVERS_MAX }, (_, i) => ({
            origin: `https://host-${i}.example.com`,
            name: null
        }));
        const reply = await ask({ kind: "importHosts", text: encodeHostList(many) });
        expect(reply).toEqual({
            ok: true,
            imported: { added: SERVERS_MAX - 2, named: 0, skipped: 2 }
        });
        expect(await stored()).toHaveLength(SERVERS_MAX);
    });
});
