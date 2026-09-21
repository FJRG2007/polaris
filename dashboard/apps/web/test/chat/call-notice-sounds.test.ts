/**
 * The notice a call draws outside the window, and whether it makes a sound.
 *
 * Every other notice in Polaris is deliberately silent: the tab chimes for what
 * it draws, and one event with two sounds is worse than either. A call is the
 * exception, and it is the exception for the reason the notice exists at all -
 * it is only ever raised when nobody is looking at the tab, and a tab nobody is
 * looking at is one whose audio the browser is free to suspend. Polaris' own
 * ring is then scheduled into a context that is not running, nothing comes out
 * of the speakers, and a silent notice made a call the one thing here that could
 * pass in complete silence.
 *
 * So this pins the one boolean, and the standing that decides whether anything
 * is drawn at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice constructed, with the options it was given. */
let drawn: { title: string; options: Record<string, unknown> }[] = [];
let permission: NotificationPermission = "granted";
let asked = 0;

class FakeNotification {
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(title: string, options: Record<string, unknown>) {
        drawn.push({ title, options });
    }
    close(): void {}
    static get permission(): NotificationPermission {
        return permission;
    }
    static async requestPermission(): Promise<NotificationPermission> {
        asked += 1;
        return permission;
    }
}

beforeEach(() => {
    drawn = [];
    asked = 0;
    permission = "granted";
    vi.stubGlobal("window", { Notification: FakeNotification });
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("document", { visibilityState: "hidden" });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

async function notifier() {
    return await import("@/lib/desktop-notify");
}

describe("a notice drawn for a call", () => {
    it("makes a sound of its own", async () => {
        const { notifyDesktop } = await notifier();

        await notifyDesktop({ title: "Ana is calling", tag: "call:m1", insistent: true, sound: true });

        expect(drawn[0]?.options.silent).toBe(false);
        // And stays up: a call is not something to glance at and lose.
        expect(drawn[0]?.options.requireInteraction).toBe(true);
    });

    it("leaves everything else silent, which is what the tab chimes for", async () => {
        const { notifyDesktop } = await notifier();

        await notifyDesktop({ title: "New mail", tag: "mail:1" });

        expect(drawn[0]?.options.silent).toBe(true);
    });
});

describe("whether Polaris may reach past the window at all", () => {
    it("is askable until this browser has answered", async () => {
        permission = "default";
        const { noticeStanding } = await notifier();

        expect(noticeStanding()).toBe("askable");
    });

    it("is refused once it has been, and nothing is drawn", async () => {
        permission = "denied";
        const { noticeStanding, notifyDesktop } = await notifier();

        expect(noticeStanding()).toBe("denied");
        expect(await notifyDesktop({ title: "Ana is calling", tag: "call:m1", sound: true })).toBeNull();
        expect(drawn).toHaveLength(0);
        // And asking again is not how a refusal is mended: the browser keeps it.
        expect(asked).toBe(0);
    });

    it("is granted when it has been granted", async () => {
        const { noticeStanding } = await notifier();

        expect(noticeStanding()).toBe("granted");
    });
});
