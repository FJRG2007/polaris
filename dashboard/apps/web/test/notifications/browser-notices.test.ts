/**
 * Which interruptions this browser is allowed to draw outside its window.
 *
 * Everything about this setting is about not losing something somebody depends
 * on, so that is what is pinned: a device that has never been asked gets every
 * notice it got before the setting existed, one kind switched off leaves the
 * others alone, and a browser that refuses storage still honours the choice for
 * as long as the tab is open rather than reverting halfway through the day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A localStorage that can be told to refuse, as a private window does. */
function storage(initial: Record<string, string> = {}, refuse = false) {
    const held = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => {
            if (refuse) throw new Error("storage is full");
            held.set(key, value);
        },
        removeItem: (key: string) => void held.delete(key),
        seen: held
    };
}

function windowWith(store: ReturnType<typeof storage>) {
    vi.stubGlobal("window", {
        localStorage: store,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true
    });
}

async function notices() {
    return await import("@/lib/notifications/browser-notices");
}

beforeEach(() => {
    windowWith(storage());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("what a browser may draw outside its window", () => {
    it("allows every kind on a device that has never been asked", async () => {
        const { NOTICE_KINDS, noticeAllowed } = await notices();
        for (const kind of NOTICE_KINDS) expect(noticeAllowed(kind)).toBe(true);
    });

    it("switches one kind off without touching the rest", async () => {
        const { noticeAllowed, setNoticeAllowed } = await notices();
        setNoticeAllowed("mail", false);

        expect(noticeAllowed("mail")).toBe(false);
        expect(noticeAllowed("calls")).toBe(true);
        expect(noticeAllowed("messages")).toBe(true);
    });

    it("remembers the choice for the next page", async () => {
        const store = storage();
        windowWith(store);
        const first = await notices();
        first.setNoticeAllowed("messages", false);

        vi.resetModules();
        windowWith(store);
        const again = await notices();
        expect(again.noticeAllowed("messages")).toBe(false);
    });

    it("holds the choice for this visit where storage is refused", async () => {
        windowWith(storage({}, true));
        const { noticeAllowed, setNoticeAllowed } = await notices();

        setNoticeAllowed("calls", false);
        expect(noticeAllowed("calls")).toBe(false);
    });

    it("ignores something that is not a setting", async () => {
        // Another build, or somebody with the console open. An unreadable value
        // means "never chosen", which is everything on.
        windowWith(storage({ "polaris.notices": JSON.stringify({ calls: "yes", mail: 0 }) }));
        const { noticeAllowed } = await notices();

        expect(noticeAllowed("calls")).toBe(true);
        expect(noticeAllowed("mail")).toBe(true);
    });

    it("answers no where there is no window at all", async () => {
        // A server render reaches this module through the components that import
        // it, and a notice cannot be drawn from there in any case.
        vi.stubGlobal("window", undefined);
        const { noticeAllowed } = await notices();
        expect(noticeAllowed("calls")).toBe(false);
    });

    it("reports every switch for the card that draws them", async () => {
        const { noticeSettings, setNoticeAllowed } = await notices();
        setNoticeAllowed("alerts", false);

        expect(noticeSettings()).toEqual({
            calls: true,
            messages: true,
            mail: true,
            alerts: false
        });
    });
});
