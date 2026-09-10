// @vitest-environment jsdom

/**
 * The Polaris desktop app, as the dashboard sees it: the bridge is used only
 * when it is really there, the dashboard's notices go through it inside the app,
 * a finished deploy raises a notice only once, and the download link is built
 * from the repository this deployment updates from.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { desktopReleasesUrl } from "@/lib/desktop-release";
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

describe("desktopReleasesUrl", () => {
    it("links the repository's desktop releases", () => {
        expect(desktopReleasesUrl("FJRG2007/polaris")).toBe(
            "https://github.com/FJRG2007/polaris/releases?q=desktop-v&expanded=true"
        );
        expect(desktopReleasesUrl(" owner/my.repo_name ")).toBe(
            "https://github.com/owner/my.repo_name/releases?q=desktop-v&expanded=true"
        );
    });

    it("gives no link for something that is not owner/name", () => {
        for (const repo of ["", "polaris", "https://github.com/a/b", "a/b/c", "a b/c", "../x"]) {
            expect(desktopReleasesUrl(repo)).toBeNull();
        }
    });
});

describe("the install card", () => {
    it("offers the desktop download in a browser", () => {
        const html = renderToStaticMarkup(
            <InstallAppCard downloadUrl="https://github.com/o/p/releases?q=desktop-v" />
        );
        expect(html).toContain('href="https://github.com/o/p/releases?q=desktop-v"');
        expect(html).toContain("Download the desktop app");
    });

    it("offers no download when there is no link to give", () => {
        expect(renderToStaticMarkup(<InstallAppCard downloadUrl={null} />)).not.toContain(
            "Download the desktop app"
        );
    });
});
