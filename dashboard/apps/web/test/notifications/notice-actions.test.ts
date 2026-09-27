// @vitest-environment jsdom

/**
 * Buttons on a notice - "Mark as read" - in the desktop app and in a browser.
 *
 * What is pinned: the desktop app is asked for the buttons only where it can
 * hand a press back, a press makes the button's request once, and an older app
 * still draws the notice without them; in a browser the notice is drawn by the
 * service worker with the buttons and the request on it - so a press is heard
 * with no tab open - and taking it back closes that notice; with no service
 * worker it is drawn the ordinary way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const READ = {
    id: "read",
    text: "Mark as read",
    request: { url: "/api/chat/channels/c1/read", body: { messageId: "m1" } }
};

type Pressed = (action: { tag: string; action: string }) => void;

function installApp(withActions: boolean) {
    const drawn: Record<string, unknown>[] = [];
    let heard: Pressed | null = null;
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "1.0.0",
        platform: "win32",
        notify: async (input: Record<string, unknown>) => {
            drawn.push(input);
            return true;
        },
        closeNotice: async () => undefined,
        pickFolder: async () => null,
        pushLocal: async () => ({ ok: true }),
        openWindow: async () => ({ ok: true }),
        ...(withActions
            ? {
                  onNoticeAction: (listener: Pressed) => {
                      heard = listener;
                      return () => undefined;
                  }
              }
            : {})
    };
    return { drawn, press: (action: { tag: string; action: string }) => heard?.(action) };
}

const posted: { url: string; body: string }[] = [];

beforeEach(() => {
    vi.resetModules();
    posted.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            posted.push({ url, body: String(init.body) });
            return new Response(null, { status: 204 });
        })
    );
});

afterEach(() => {
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
    vi.unstubAllGlobals();
});

describe("a notice's buttons in the desktop app", () => {
    it("asks for them, and a press makes the button's request once", async () => {
        const app = installApp(true);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        await notifyDesktop({ title: "Ana", tag: "message:c1", actions: [READ] });
        expect(app.drawn[0]).toEqual({
            title: "Ana",
            tag: "message:c1",
            actions: [{ id: "read", text: "Mark as read" }]
        });
        app.press({ tag: "message:c2", action: "read" });
        app.press({ tag: "message:c1", action: "read" });
        app.press({ tag: "message:c1", action: "read" });
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toEqual({
            url: "/api/chat/channels/c1/read",
            body: JSON.stringify({ messageId: "m1" })
        });
    });

    it("hands a press on a notice from before a reload to what takes unclaimed ones", async () => {
        const app = installApp(true);
        const { actOnUnclaimedNotices, notifyDesktop } = await import("@/lib/desktop-notify");
        const unclaimed: { tag: string; action: string }[] = [];
        actOnUnclaimedNotices(async (tag, action) => {
            unclaimed.push({ tag, action });
        });
        app.press({ tag: "message:c2", action: "read" });
        await notifyDesktop({ title: "Ana", tag: "message:c1", actions: [READ] });
        app.press({ tag: "message:c1", action: "read" });
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        expect(unclaimed).toEqual([{ tag: "message:c2", action: "read" }]);
    });

    it("draws the notice without them in an app too old to hand a press back", async () => {
        const app = installApp(false);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        await notifyDesktop({ title: "Ana", tag: "message:c1", actions: [READ] });
        expect(app.drawn[0]).toEqual({ title: "Ana", tag: "message:c1" });
    });
});

describe("a notice's buttons in a browser", () => {
    function installBrowser(worker: boolean) {
        const shown: { title: string; options: Record<string, unknown> }[] = [];
        const closed: string[] = [];
        const registration = {
            active: {},
            showNotification: async (title: string, options: Record<string, unknown>) => {
                shown.push({ title, options });
            },
            getNotifications: async ({ tag }: { tag: string }) => [
                { close: () => closed.push(tag) }
            ]
        };
        vi.stubGlobal(
            "Notification",
            Object.assign(
                vi.fn(function Plain(this: Record<string, unknown>, title: string) {
                    this.title = title;
                    this.close = () => undefined;
                }),
                { permission: "granted", requestPermission: async () => "granted" }
            )
        );
        const heard: ((event: { data: unknown }) => void)[] = [];
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: {
                getRegistration: async () => (worker ? registration : undefined),
                addEventListener: (_kind: string, listener: (event: { data: unknown }) => void) =>
                    heard.push(listener),
                startMessages: () => undefined
            }
        });
        return { shown, closed, heard };
    }

    it("is drawn by the service worker, with the buttons and their requests on it", async () => {
        const browser = installBrowser(true);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        const handle = await notifyDesktop({
            title: "Ana",
            body: "are you coming?",
            tag: "message:c1",
            href: "/chat/c/c1/m1",
            actions: [READ]
        });
        expect(browser.shown).toHaveLength(1);
        expect(browser.shown[0]!.options).toMatchObject({
            tag: "message:c1",
            actions: [{ action: "read", title: "Mark as read" }],
            data: { href: "/chat/c/c1/m1", actions: [READ] }
        });
        handle?.close();
        await vi.waitFor(() => expect(browser.closed).toEqual(["message:c1"]));
    });

    it("is drawn the ordinary way where no service worker runs", async () => {
        const browser = installBrowser(false);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        expect(
            await notifyDesktop({ title: "Ana", tag: "message:c1", actions: [READ] })
        ).not.toBeNull();
        expect(browser.shown).toHaveLength(0);
        expect(Notification).toHaveBeenCalledTimes(1);
    });

    it("goes where a pressed notice points from page start, in a tab that drew nothing", async () => {
        const browser = installBrowser(true);
        const assign = vi.fn();
        vi.stubGlobal("location", { ...window.location, assign });
        const { listenToWorker } = await import("@/lib/desktop-notify");
        listenToWorker();
        listenToWorker();
        expect(browser.heard).toHaveLength(1);
        browser.heard[0]!({ data: { kind: "polaris-notice-open", href: "//elsewhere.test" } });
        browser.heard[0]!({ data: { kind: "polaris-notice-open", href: "/chat/c/c1/m1" } });
        expect(assign.mock.calls).toEqual([["/chat/c/c1/m1"]]);
    });
});
