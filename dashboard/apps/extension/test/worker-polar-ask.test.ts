/**
 * A right-click "ask" through the real worker: it has to reach the panel open
 * beside the tab that was clicked, never a panel open beside another one - and
 * a question asked before any panel is open has to wait for that tab's panel,
 * not whichever one happens to connect next.
 *
 * Driven against WXT's fake browser, with `main()` run so the worker's own
 * `runtime.onConnect` and `contextMenus.onClicked` listeners - where the fix
 * lives - are the ones under test, not a reimplementation of them.
 */

import * as polar from "../src/lib/polar-panel";
import { POLAR_MENU } from "../src/lib/context-menu";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: never[]) => unknown;

let connectListener: ((port: unknown) => void) | null = null;
let clickListener: ((info: unknown, tab: unknown) => void) | null = null;

/** Everything `main()` touches that the fake browser does not implement on its
 *  own - the same kind of stand-in `worker-hosts.test.ts` uses, plus the ports
 *  (`runtime.onConnect`) and menu clicks (`contextMenus.onClicked`) this suite
 *  drives by hand. */
function stubBrowserApis(): void {
    connectListener = null;
    clickListener = null;
    (fakeBrowser as unknown as { permissions: unknown }).permissions = {
        contains: async () => true,
        request: async () => true,
        getAll: async () => ({ origins: [], permissions: [] }),
        onAdded: { addListener() {} },
        onRemoved: { addListener() {} }
    };
    (fakeBrowser as unknown as { contextMenus: unknown }).contextMenus = {
        create() {},
        update: async () => {},
        removeAll: async () => {},
        onClicked: {
            addListener(fn: Listener) {
                clickListener = fn as (info: unknown, tab: unknown) => void;
            }
        }
    };
    (fakeBrowser as unknown as { scripting: unknown }).scripting = {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {}
    };
    // `installType()` asks this to decide whether a copy on disk could be
    // waiting to restart into; "normal" keeps that path from ever starting.
    (fakeBrowser as unknown as { management: unknown }).management = {
        getSelf: async () => ({ installType: "normal" })
    };
    (fakeBrowser as unknown as { sidePanel: unknown }).sidePanel = {
        setOptions: async () => undefined,
        open: async () => undefined,
        close: async () => undefined
    };
    (fakeBrowser as unknown as { commands: unknown }).commands = {
        onCommand: { addListener() {} }
    };
    (fakeBrowser.runtime as unknown as { onConnect: unknown }).onConnect = {
        addListener(fn: Listener) {
            connectListener = fn as (port: unknown) => void;
        }
    };
}

/** A panel's port: connects for `tabId` in `windowId`, the way the real panel
 *  opens one and says hello. Its `postMessage` is a spy a test reads from. */
function fakePort(tabId: number, windowId: number): { postMessage: ReturnType<typeof vi.fn> } {
    let onMessage: Listener = () => {};
    const port = {
        name: polar.PANEL_PORT,
        postMessage: vi.fn(),
        onMessage: {
            addListener(fn: Listener) {
                onMessage = fn;
            }
        },
        onDisconnect: { addListener() {} }
    };
    connectListener?.(port);
    onMessage({ kind: "hello", windowId, tabId } as never);
    return port;
}

/** One pass of every microtask a storage read or write queued. */
async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    stubBrowserApis();
    const background = await import("../src/entrypoints/background");
    background.default.main?.();
    await tick();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("a right-click 'ask', with two panels already open", () => {
    it("reaches only the panel beside the clicked tab", async () => {
        const besideTabA = fakePort(100, 1);
        const besideTabB = fakePort(200, 2);

        clickListener?.(
            { menuItemId: POLAR_MENU.selection, selectionText: "hello world" },
            { id: 100, windowId: 1, url: "https://example.com" }
        );
        await tick();

        expect(besideTabA.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "ask", quote: "hello world" })
        );
        expect(besideTabB.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: "ask" })
        );
    });
});

describe("a right-click 'ask', with no panel open for that tab yet", () => {
    it("waits for that tab's own panel, not whichever one opens next", async () => {
        clickListener?.(
            { menuItemId: POLAR_MENU.selection, selectionText: "hello world" },
            { id: 300, windowId: 3, url: "https://example.com" }
        );
        await tick();

        // A panel opening beside a different tab does not take it.
        const besideTabB = fakePort(200, 2);
        await tick();
        expect(besideTabB.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ kind: "ask" })
        );

        // The panel opening beside the tab it was asked on does.
        const besideTabC = fakePort(300, 3);
        await tick();
        expect(besideTabC.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "ask", quote: "hello world" })
        );
    });
});
