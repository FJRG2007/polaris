/**
 * Days that are over are drawn like any other day unless somebody asks.
 *
 * The fading used to be on by default, and because any change in settings
 * stored the whole document, the old `dimPast: true` sits in nearly every stored
 * one whether or not its owner chose it. So it is stored under a new name, and
 * the old one is not read.
 */

import { describe, expect, it } from "vitest";
import { readPreferences } from "@polaris-app/calendar/src/lib/preferences";

describe("fading past days", () => {
    it("is off for somebody who never touched it", () => {
        expect(readPreferences(null).fadePast).toBe(false);
    });

    it("stays off for a document saved while the old default was on", () => {
        expect(readPreferences(JSON.stringify({ dimPast: true, showTasks: true })).fadePast).toBe(false);
    });

    it("is on for somebody who turned it on", () => {
        expect(readPreferences(JSON.stringify({ fadePast: true })).fadePast).toBe(true);
    });
});
