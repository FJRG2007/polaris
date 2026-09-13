// @vitest-environment jsdom

/**
 * The Polaris desktop app, as the dashboard sees it: the bridge is used only
 * when it is really there, the dashboard's notices go through it inside the app,
 * a finished deploy raises a notice only once, and the download is offered only
 * for a release of the app that actually exists.
 */

import { desktopDownload } from "@/lib/app-releases";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallAppCard } from "@/components/installed-app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    arrivedDeployResults,
    desktopBridge,
    isDesktopBridge,
    type PolarisDesktop
} from "@/lib/desktop-bridge";

function fakeBridge(overrides: Partial<PolarisDesktop> = {}): PolarisDesktop {
    return {
        version: "0.1.0",
        platform: "win32",
        notify: vi.fn(async () => true),
        closeNotice: vi.fn(async () => undefined),
        pickFolder: vi.fn(async () => null),
        pushLocal: vi.fn(async () => ({ ok: true as const })),
        openWindow: vi.fn(async () => ({ ok: true as const })),
        ...overrides
    };
}

function install(value: unknown): void {
    Object.defineProperty(window, "polarisDesktop", { value, configurable: true, writable: true });
}

afterEach(() => {
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
    vi.resetModules();
});

describe("desktopBridge", () => {
    it("is null in a browser", () => {
        expect(desktopBridge()).toBeNull();
    });

    it("is the app's bridge inside the app", () => {
        const bridge = fakeBridge();
        install(bridge);
        expect(desktopBridge()).toBe(bridge);
    });

    it("ignores something with the right name and the wrong shape", () => {
        install({ version: "1" });
        expect(desktopBridge()).toBeNull();
        install({ ...fakeBridge(), version: 3 });
        expect(desktopBridge()).toBeNull();
        install({ ...fakeBridge(), pushLocal: "yes" });
        expect(desktopBridge()).toBeNull();
        expect(isDesktopBridge(null)).toBe(false);
        expect(isDesktopBridge("polarisDesktop")).toBe(false);
    });
});

describe("notifyDesktop inside the app", () => {
    it("draws the notice through the bridge, and takes it back by its tag", async () => {
        const bridge = fakeBridge();
        install(bridge);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        const shown = await notifyDesktop({
            title: "Call from Ada",
            tag: "call:1",
            href: "/chat/1",
            insistent: true
        });
        expect(bridge.notify).toHaveBeenCalledWith({
            title: "Call from Ada",
            tag: "call:1",
            href: "/chat/1",
            insistent: true
        });
        shown?.close();
        expect(bridge.closeNotice).toHaveBeenCalledWith("call:1");
    });

    it("answers null when the app could not show it", async () => {
        install(fakeBridge({ notify: vi.fn(async () => false) }));
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        expect(await notifyDesktop({ title: "x", tag: "t" })).toBeNull();
    });
});

describe("arrivedDeployResults", () => {
    const row = (id: string, type: string, read = false) => ({ id, type, read });

    it("keeps deploy results that are new and unread, and nothing else", () => {
        const seen = new Set(["old"]);
        const rows = [
            row("old", "deploy.failed"),
            row("new-ok", "deploy.succeeded"),
            row("new-fail", "deploy.failed"),
            row("read", "deploy.failed", true),
            row("chat", "chat.callMissed")
        ];
        expect(arrivedDeployResults(seen, rows).map((item) => item.id)).toEqual([
            "new-ok",
            "new-fail"
        ]);
    });
});

describe("desktopDownload", () => {
    it("asks for nothing at all when the repository is not owner/name", async () => {
        // A typo in the environment used to become a link to a page that was not
        // there. Now it must not even become a request: asserted by counting the
        // calls, because "returned null" alone would also be true of a lookup that
        // went out, failed, and swallowed the failure.
        const fetching = vi.fn();
        vi.stubGlobal("fetch", fetching);
        try {
            for (const repo of [
                "",
                "polaris",
                "https://github.com/a/b",
                "a/b/c",
                "a b/c",
                "../x"
            ]) {
                expect(await desktopDownload(repo)).toBeNull();
            }
            expect(fetching).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("the install card", () => {
    it("draws whole while the download is still being looked up", () => {
        // What lets the offer stream in behind a boundary instead of holding the
        // page: the card does not wait on it, so everything saying the native app
        // exists is on screen before GitHub has answered. The two states of the
        // offer itself are asserted in `app-download`.
        const html = renderToStaticMarkup(<InstallAppCard nativeApp={null} />);
        expect(html).toContain("There is also a native app");
        expect(html).not.toContain("Download the desktop app");
    });

    it("draws the offer it is handed", () => {
        const html = renderToStaticMarkup(<InstallAppCard nativeApp={<b>An offer</b>} />);
        expect(html).toContain("<b>An offer</b>");
    });
});
