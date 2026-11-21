/**
 * Media auto-download, WhatsApp style: photos always, videos and documents on
 * Wi-Fi, a phone with no network type taken as cellular, and the oldest files
 * dropped to stay under the limit.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/chat/offline/media-download";

const PHONE = "Mozilla/5.0 (Linux; Android 14) Mobile";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

describe("media auto-download", () => {
    it("works with no setting stored, and repairs a malformed one", () => {
        expect(rules.readMediaPrefs(null)).toEqual(rules.MEDIA_DOWNLOAD_DEFAULTS);
        expect(rules.readMediaPrefs({ videos: "always" }).videos).toBe("always");
        expect(rules.readMediaPrefs({ capMb: 123 })).toEqual(rules.MEDIA_DOWNLOAD_DEFAULTS);
        expect(rules.readMediaPrefs("nonsense")).toEqual(rules.MEDIA_DOWNLOAD_DEFAULTS);
    });

    it("fetches photos always and videos and documents only on Wi-Fi by default", () => {
        const prefs = rules.MEDIA_DOWNLOAD_DEFAULTS;
        expect(rules.shouldDownload(rules.mediaKindOf("image/png"), prefs, "cellular")).toBe(true);
        expect(rules.shouldDownload(rules.mediaKindOf("video/mp4"), prefs, "cellular")).toBe(false);
        expect(rules.shouldDownload(rules.mediaKindOf("video/mp4"), prefs, "wifi")).toBe(true);
        expect(rules.shouldDownload(rules.mediaKindOf("application/pdf"), prefs, "wifi")).toBe(true);
        expect(rules.shouldDownload("photos", prefs, "offline")).toBe(false);
        expect(rules.shouldDownload("photos", { ...prefs, photos: "never" }, "wifi")).toBe(false);
    });

    it("reads the network, taking a phone that does not say as cellular", () => {
        expect(rules.networkKindOf({ online: true, type: "wifi", userAgent: PHONE })).toBe("wifi");
        expect(rules.networkKindOf({ online: true, type: "cellular", userAgent: DESKTOP })).toBe("cellular");
        expect(rules.networkKindOf({ online: true, userAgent: PHONE })).toBe("cellular");
        expect(rules.networkKindOf({ online: true, userAgent: DESKTOP })).toBe("wifi");
        expect(rules.networkKindOf({ online: true, type: "wifi", saveData: true, userAgent: DESKTOP })).toBe("cellular");
        expect(rules.networkKindOf({ online: false, type: "wifi", userAgent: DESKTOP })).toBe("offline");
    });

    it("drops the oldest files until what is kept fits, and never one file past a quarter", () => {
        const kept = [
            { url: "new", size: 40, at: 3 },
            { url: "old", size: 40, at: 1 },
            { url: "mid", size: 40, at: 2 }
        ];
        expect(rules.mediaOverCap(kept, 100)).toEqual(["old"]);
        expect(rules.mediaOverCap(kept, 200)).toEqual([]);
        expect(rules.fitsUnderCap(30, 100)).toBe(false);
        expect(rules.fitsUnderCap(25, 100)).toBe(true);
    });
});
