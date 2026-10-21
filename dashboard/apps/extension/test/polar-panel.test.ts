/**
 * Polar beside the page: the frame's address, which tabs count as a site to
 * ask about, what crosses to the frame and from it, the shortcut as each
 * browser registers it, and the panel opening inside the gesture.
 */

import config from "../wxt.config";
import * as polar from "../src/lib/polar-panel";
import { FROM_PAGE } from "../src/lib/messages";
import { describe, expect, it, vi } from "vitest";

type ManifestEnv = { browser: string; manifestVersion: 2 | 3 };

function manifestFor(env: ManifestEnv): Record<string, unknown> {
    const build = config.manifest as unknown as (env: ManifestEnv) => Record<string, unknown>;
    return build(env);
}

const SERVER = "https://polaris.example";
const EXT = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;

describe("the frame", () => {
    it("is the deployment's embed, naming this extension and nothing else", () => {
        expect(polar.embedUrl(SERVER, EXT)).toBe(
            `${SERVER}/polar/embed?ext=${encodeURIComponent(EXT)}`
        );
    });

    it("asks about web pages only, and never about Polaris itself", () => {
        expect(polar.siteOf("https://news.example/a?b#c", SERVER)).toBe("https://news.example");
        expect(polar.siteOf(`${SERVER}/home`, SERVER)).toBeNull();
        expect(polar.siteOf("chrome://settings", SERVER)).toBeNull();
        expect(polar.siteOf("about:blank", SERVER)).toBeNull();
        expect(polar.siteOf(undefined, SERVER)).toBeNull();
        expect(polar.siteOf("not a url", SERVER)).toBeNull();
    });

    it("hands over a page trimmed to what the embed takes", () => {
        const page = polar.trimPage({
            url: "https://news.example/a",
            title: "  A  ",
            selection: "",
            text: "x".repeat(polar.TEXT_MOST + 50)
        });
        expect(page).toEqual({
            url: "https://news.example/a",
            title: "A",
            selection: undefined,
            text: "x".repeat(polar.TEXT_MOST)
        });
        expect(polar.trimPage({ url: "file:///etc/passwd" })).toBeNull();
        expect(polar.pageMessage(null)).toEqual({
            source: polar.FROM_EXTENSION,
            kind: "page",
            page: null
        });
    });

    it("answers a refresh only from its own frame on the deployment's origin", () => {
        const frame = {};
        const data = { source: polar.FROM_EMBED, kind: "refresh" };
        expect(polar.isRefresh({ data, origin: SERVER, source: frame }, frame, SERVER)).toBe(true);
        expect(
            polar.isRefresh({ data, origin: "https://evil.example", source: frame }, frame, SERVER)
        ).toBe(false);
        expect(polar.isRefresh({ data, origin: SERVER, source: {} }, frame, SERVER)).toBe(false);
        expect(
            polar.isRefresh({ data: "refresh", origin: SERVER, source: frame }, frame, SERVER)
        ).toBe(false);
    });

    it("adds nothing a web page may ask the worker for", () => {
        // The page is read by the panel itself; no message reads a tab.
        expect([...FROM_PAGE]).toHaveLength(15);
    });
});

describe("the shortcut", () => {
    it("is Polaris's own Ctrl+J on Chromium, as a command the worker answers", () => {
        const commands = manifestFor({ browser: "chrome", manifestVersion: 3 })[
            "commands"
        ] as Record<
            string,
            { suggested_key: { default: string; mac?: string }; description: string }
        >;
        expect(commands[polar.OPEN_POLAR]?.suggested_key).toEqual({
            default: polar.POLARIS_SHORTCUT,
            mac: polar.POLARIS_SHORTCUT_MAC
        });
        expect(commands[polar.OPEN_POLAR]?.description).toBe("__MSG_commandOpenPolar__");
        expect(commands[polar.FIREFOX_SIDEBAR]).toBeUndefined();
        // Chromium allows four suggested shortcuts in all.
        expect(Object.keys(commands).length).toBeLessThanOrEqual(4);
        expect(commands["fill-login"]).toBeDefined();
    });

    it("is a command the worker hears on Firefox too, on a key Firefox does not keep", () => {
        const commands = manifestFor({ browser: "firefox", manifestVersion: 2 })[
            "commands"
        ] as Record<string, { suggested_key: { default: string } }>;
        expect(commands[polar.OPEN_POLAR]?.suggested_key.default).toBe(polar.FIREFOX_SHORTCUT);
        // The reserved sidebar command never reaches the worker, so it could
        // not hand the press to a Polaris tab.
        expect(commands[polar.FIREFOX_SIDEBAR]).toBeUndefined();
    });

    it("is read from a key press the way Firefox takes one", () => {
        const press = (
            code: string,
            mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}
        ) => ({
            code,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false,
            ...mods
        });
        expect(polar.shortcutFrom(press("KeyP", { altKey: true }), false)).toBe("Alt+P");
        expect(polar.shortcutFrom(press("KeyK", { ctrlKey: true, shiftKey: true }), false)).toBe(
            "Ctrl+Shift+K"
        );
        expect(polar.shortcutFrom(press("KeyK", { metaKey: true }), true)).toBe("Command+K");
        expect(polar.shortcutFrom(press("Digit4", { altKey: true }), false)).toBe("Alt+4");
        expect(polar.shortcutFrom(press("F7"), false)).toBe("F7");
        // A bare letter, Shift alone, or a modifier on its own are not shortcuts.
        expect(polar.shortcutFrom(press("KeyP"), false)).toBeNull();
        expect(polar.shortcutFrom(press("KeyP", { shiftKey: true }), false)).toBeNull();
        expect(polar.shortcutFrom(press("AltLeft", { altKey: true }), false)).toBeNull();
    });

    it("is changed on each Chromium browser's own screen", () => {
        expect(polar.shortcutsPage("Chrome")).toBe("chrome://extensions/shortcuts");
        expect(polar.shortcutsPage("Brave")).toBe("chrome://extensions/shortcuts");
        expect(polar.shortcutsPage("Edge")).toBe("edge://extensions/shortcuts");
    });
});

describe("opening the panel", () => {
    it("opens Chromium's side panel for the window, without awaiting first", () => {
        const open = vi.fn(() => Promise.resolve());
        expect(polar.openSidePanel({ sidePanel: { open } }, 7)).toBe(true);
        expect(open).toHaveBeenCalledWith({ windowId: 7 });
        expect(polar.openSidePanel({ sidePanel: { open } }, undefined)).toBe(false);
    });

    it("opens Firefox's sidebar, and nothing where neither exists", () => {
        const open = vi.fn(() => Promise.resolve());
        expect(polar.openSidePanel({ sidebarAction: { open } }, undefined)).toBe(true);
        expect(open).toHaveBeenCalledOnce();
        expect(polar.openSidePanel({}, 1)).toBe(false);
    });
});

describe("which Polar a press reaches", () => {
    const KNOWN = [SERVER, "https://other.example:8443"];

    it("hands it to the page's own Polar on a Polaris tab", () => {
        expect(polar.isPolarisTab(`${SERVER}/home`, KNOWN)).toBe(true);
        expect(polar.isPolarisTab("https://other.example:8443/polar", KNOWN)).toBe(true);
        expect(polar.routeFor({ url: `${SERVER}/tasks` }, KNOWN, true)).toBe("polaris");
        expect(polar.routeFor({ url: `${SERVER}/tasks` }, KNOWN, false)).toBe("polaris");
    });

    it("opens or closes the extension's panel everywhere else", () => {
        expect(polar.isPolarisTab("https://other.example/x", KNOWN)).toBe(false);
        expect(polar.isPolarisTab("https://polaris.example.evil.test/", KNOWN)).toBe(false);
        expect(polar.isPolarisTab("chrome://newtab", KNOWN)).toBe(false);
        expect(polar.isPolarisTab(undefined, KNOWN)).toBe(false);
        expect(polar.routeFor({ url: "https://news.example" }, KNOWN, false)).toBe("open");
        expect(polar.routeFor({ url: "https://news.example" }, KNOWN, true)).toBe("close");
        expect(polar.routeFor(undefined, [], false)).toBe("open");
    });

    it("tells a Polaris page to toggle, or to open with a question", () => {
        expect(polar.polarisCommand()).toEqual({
            source: polar.FROM_EXTENSION,
            kind: "polar",
            action: "toggle"
        });
        expect(polar.polarisCommand({ quote: "  hi  ", draft: "Explain" })).toEqual({
            source: polar.FROM_EXTENSION,
            kind: "polar",
            action: "ask",
            quote: "hi",
            draft: "Explain"
        });
        const long = polar.askMessage({ quote: "x".repeat(polar.SELECTION_MOST + 9) });
        expect(long.quote).toHaveLength(polar.SELECTION_MOST);
    });

    it("sends the command into the tab with the browser's script call", () => {
        const executeScript = vi.fn(async () => []);
        polar.sendToPolarisTab({ scripting: { executeScript } }, 7, { a: 1 });
        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 7 },
            func: polar.postToPolarisPage,
            args: [{ a: 1 }]
        });
        const legacy = vi.fn(async (_id: number, _details: unknown) => []);
        polar.sendToPolarisTab({ tabs: { executeScript: legacy } }, 8, { a: 1 });
        expect(legacy.mock.calls[0]?.[0]).toBe(8);
    });

    it("opens a tab's own panel in the per-tab scope, the window's otherwise", () => {
        const calls: string[] = [];
        const sidePanel = {
            open: vi.fn(async (options: object) => {
                calls.push(`open ${JSON.stringify(options)}`);
            }),
            setOptions: vi.fn(async (options: object) => {
                calls.push(`set ${JSON.stringify(options)}`);
            })
        };
        expect(polar.openPolarFor({ sidePanel }, { id: 3, windowId: 1 }, "tab")).toBe(true);
        expect(calls).toEqual([
            `set {"tabId":3,"path":"sidepanel.html?tab=3","enabled":true}`,
            `open {"tabId":3}`
        ]);
        calls.length = 0;
        expect(polar.openPolarFor({ sidePanel }, { id: 3, windowId: 1 }, "all")).toBe(true);
        expect(calls).toEqual([`open {"windowId":1}`]);
    });

    it("keeps a conversation per tab only when asked to", () => {
        expect(polar.chatScopeFor("shared", 4)).toBeNull();
        expect(polar.chatScopeFor("tab", 4)).toBe("tab-4");
        expect(polar.chatScopeFor("tab", null)).toBeNull();
        expect(polar.embedUrl(SERVER, EXT, "tab-4")).toContain("chat=tab-4");
        expect(polar.readPanelScope("weird")).toBe("all");
        expect(polar.readChatScope(undefined)).toBe("shared");
    });
});
