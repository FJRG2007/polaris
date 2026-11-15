/**
 * One-tag setup: the site's switches are read whole (anything unreadable is all
 * off), only the script's own switches are served to it, and the two privacy
 * switches are enforced on the server.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import * as options from "@/lib/analytics-tracker-options";

describe("tracker options", () => {
    it("reads a stored value, and treats anything unreadable as every switch off", () => {
        expect(options.parseTrackerOptions('{"vitals":true}')).toMatchObject({ vitals: true, outbound: false });
        expect(options.parseTrackerOptions("not json").vitals).toBe(false);
        expect(options.parseTrackerOptions('{"vitals":"yes"}').vitals).toBe(false);
        expect(options.parseTrackerOptions('{"surprise":true}').vitals).toBe(false);
        expect(options.parseTrackerOptions(null).doNotTrack).toBe(false);
    });

    it("serves only the script's switches that are on, as attribute names", () => {
        const all = options.parseTrackerOptions(JSON.stringify(Object.fromEntries(options.TRACKER_OPTIONS.map((name) => [name, true]))));
        expect(options.scriptOptions(all)).toEqual({
            "data-outbound": true,
            "data-downloads": true,
            "data-forms": true,
            "data-hash": true,
            "data-vitals": true
        });
        expect(options.scriptOptions(options.parseTrackerOptions("{}"))).toEqual({});
    });

    it("drops the query string and keeps a hash route", () => {
        expect(options.withoutSearch("/a?b=1")).toBe("/a");
        expect(options.withoutSearch("/a?b=1#/c")).toBe("/a#/c");
        expect(options.withoutSearch("/a#/c?d")).toBe("/a#/c?d");
        expect(options.withoutSearch("/a")).toBe("/a");
    });

    it("hears Do Not Track and Global Privacy Control", () => {
        expect(options.asksNotToTrack(new Headers({ dnt: "1" }))).toBe(true);
        expect(options.asksNotToTrack(new Headers({ "sec-gpc": "1" }))).toBe(true);
        expect(options.asksNotToTrack(new Headers({ dnt: "0" }))).toBe(false);
    });
});
