// @vitest-environment jsdom

/**
 * Which view the calendar opens on on a phone, and that the pick stays on the
 * device.
 *
 * What is pinned:
 * - with nothing stored a phone opens on the schedule;
 * - a stored phone view is reopened; anything else stored is ignored;
 * - a view the address names wins over the stored one;
 * - the pick is written to this device's storage and read back, and storage
 *   that throws (private window, blocked site data) never breaks the screen;
 * - the custom view is three days on a phone and the setting elsewhere.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_PHONE_VIEW,
    PHONE_DAYS,
    PHONE_VIEW_KEY,
    PHONE_VIEWS,
    daysFor,
    isPhoneView,
    openingPhoneView,
    readPhoneView,
    writePhoneView
} from "@polaris-app/calendar/src/screens/phone-view";

afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
});

describe("openingPhoneView", () => {
    it("opens on the schedule when nothing is stored", () => {
        expect(DEFAULT_PHONE_VIEW).toBe("list");
        expect(openingPhoneView(null, null)).toBe("list");
    });

    it("reopens the view the device was left on", () => {
        for (const view of PHONE_VIEWS) expect(openingPhoneView(null, view)).toBe(view);
    });

    it("ignores a stored value that is not a phone view", () => {
        expect(openingPhoneView(null, "year")).toBe("list");
        expect(openingPhoneView(null, "nonsense")).toBe("list");
        expect(openingPhoneView(null, 3)).toBe("list");
        expect(isPhoneView("year")).toBe(false);
    });

    it("lets the address win", () => {
        expect(openingPhoneView("week", "month")).toBe("week");
        expect(openingPhoneView("year", "month")).toBe("year");
    });
});

describe("per-device storage", () => {
    it("writes the pick and reads it back", () => {
        writePhoneView("month");
        expect(window.localStorage.getItem(PHONE_VIEW_KEY)).toBe("month");
        expect(readPhoneView()).toBe("month");
        expect(openingPhoneView(null, readPhoneView())).toBe("month");
    });

    it("survives storage that throws", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(() => writePhoneView("day")).not.toThrow();
        expect(readPhoneView()).toBeNull();
        expect(openingPhoneView(null, readPhoneView())).toBe("list");
    });
});

describe("daysFor", () => {
    it("is three days on a phone and the setting elsewhere", () => {
        expect(PHONE_DAYS).toBe(3);
        expect(daysFor(true, 5)).toBe(3);
        expect(daysFor(false, 5)).toBe(5);
    });
});
