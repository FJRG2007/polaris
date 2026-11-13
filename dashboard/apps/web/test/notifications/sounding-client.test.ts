// @vitest-environment jsdom

/**
 * One client of an account makes the sounds, and the desktop app is it whenever
 * it is open: the server elects the kind, and a page of the other kind refuses
 * every device-scoped claim - the chime, a message's sound, a call's ring and the
 * notices for them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    chimingKind,
    closeLiveClient,
    openLiveClient,
    resetLiveClients
} from "@/lib/notifications/live-clients";
import {
    anotherClientSounds,
    noteSounder,
    resetSounder,
    thisClientRings,
    yieldsTo
} from "@/lib/notifications/sounding-client";
import { claimForDevice } from "@/lib/device-once";

const AT = 1_700_000_000_000;

/** A store of this browser's own, which jsdom does not reliably supply. */
function storage(): void {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key)
        }
    });
}

/** What the desktop app puts on the page, as far as detection reads it. */
function asDesktopApp(): void {
    const call = vi.fn(async () => true);
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "1.0.0",
        platform: "win32",
        notify: call,
        closeNotice: call,
        pickFolder: call,
        pushLocal: call,
        openWindow: call
    };
}

beforeEach(() => {
    resetLiveClients();
    resetSounder();
    storage();
});

afterEach(() => {
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("which kind of client the server elects", () => {
    it("names nobody for an account with no connection", () => {
        expect(chimingKind("u", AT)).toBeNull();
    });

    it("names the desktop app over a browser opened before it", () => {
        openLiveClient("u", "tab", "browser", true, AT);
        openLiveClient("u", "app", "desktop", true, AT + 5_000);
        expect(chimingKind("u", AT + 5_000)).toBe("desktop");
    });

    it("hands it back to the browser once the app closes", () => {
        openLiveClient("u", "tab", "browser", true, AT);
        openLiveClient("u", "app", "desktop", true, AT);
        closeLiveClient("u", "app");
        expect(chimingKind("u", AT)).toBe("browser");
    });

    it("passes over an app whose sound is switched off", () => {
        openLiveClient("u", "tab", "browser", true, AT);
        openLiveClient("u", "app", "desktop", false, AT);
        expect(chimingKind("u", AT)).toBe("browser");
    });

    it("keeps accounts apart", () => {
        openLiveClient("a", "app", "desktop", true, AT);
        openLiveClient("b", "tab", "browser", true, AT);
        expect(chimingKind("b", AT)).toBe("browser");
    });
});

describe("yielding", () => {
    it("yields only to the other kind", () => {
        expect(yieldsTo("browser", "desktop")).toBe(true);
        expect(yieldsTo("desktop", "browser")).toBe(true);
        expect(yieldsTo("browser", "browser")).toBe(false);
        expect(yieldsTo("desktop", "desktop")).toBe(false);
    });

    it("never yields to nobody", () => {
        expect(yieldsTo("browser", null)).toBe(false);
    });

    it("keeps a browser quiet while the app is elected, and only then", () => {
        noteSounder(JSON.stringify({ items: [], chime: false, sounder: "desktop" }));
        expect(anotherClientSounds()).toBe(true);
        noteSounder(JSON.stringify({ items: [], chime: true, sounder: "browser" }));
        expect(anotherClientSounds()).toBe(false);
    });

    it("lets the app sound when it is the one elected", () => {
        asDesktopApp();
        noteSounder(JSON.stringify({ items: [], sounder: "desktop" }));
        expect(anotherClientSounds()).toBe(false);
    });

    it("silences nobody on a frame from a server that does not say", () => {
        noteSounder(JSON.stringify({ items: [], sounder: "desktop" }));
        noteSounder(JSON.stringify({ items: [], chime: true }));
        expect(anotherClientSounds()).toBe(false);
    });

    it("silences nobody on a frame it cannot read", () => {
        noteSounder(JSON.stringify({ sounder: "desktop" }));
        noteSounder("not json");
        expect(anotherClientSounds()).toBe(false);
        noteSounder(JSON.stringify({ sounder: "phone" }));
        expect(anotherClientSounds()).toBe(false);
    });
});

describe("the one client that rings an alarm", () => {
    it("rings only on the connection the server elected", () => {
        // Two browsers are the same kind; the kind alone would ring both.
        noteSounder(JSON.stringify({ items: [], chime: false, sounder: "browser" }));
        expect(thisClientRings()).toBe(false);
        noteSounder(JSON.stringify({ items: [], chime: true, sounder: "browser" }));
        expect(thisClientRings()).toBe(true);
    });

    it("rings before any frame, and on one that does not say", () => {
        expect(thisClientRings()).toBe(true);
        noteSounder(JSON.stringify({ items: [], chime: false }));
        noteSounder(JSON.stringify({ items: [] }));
        expect(thisClientRings()).toBe(true);
        noteSounder("not json");
        expect(thisClientRings()).toBe(true);
    });
});

describe("claims made by a client that yields", () => {
    it("refuses a browser tab's claim while the app is elected", async () => {
        noteSounder(JSON.stringify({ sounder: "desktop" }));
        await expect(claimForDevice("ring:m1")).resolves.toBe(false);
    });

    it("grants the app's claim while it is elected", async () => {
        asDesktopApp();
        noteSounder(JSON.stringify({ sounder: "desktop" }));
        await expect(claimForDevice("ring:m2")).resolves.toBe(true);
    });

    it("grants a browser tab's claim again once the app is gone", async () => {
        noteSounder(JSON.stringify({ sounder: "desktop" }));
        await expect(claimForDevice("ring:m3")).resolves.toBe(false);
        noteSounder(JSON.stringify({ sounder: "browser" }));
        await expect(claimForDevice("ring:m3")).resolves.toBe(true);
    });
});
