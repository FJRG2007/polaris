/**
 * A session that lives across an update shows the version it runs now, not the
 * one it signed in with - "Polaris Desktop 0.1.1" on an app that was on 0.1.40.
 */

import { describeClient } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn(async () => ({}));
vi.mock("@polaris/db", () => ({ prisma: { sessionState: { update } } }));

const { followClientVersion } = await import("@/lib/session-client-version");

const desktop = (version: string) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Polaris/${version} Chrome/146.0.0.0 Electron/44.3.0 Safari/537.36`;
const firefox =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

const recorded = (userAgent: string) => ({ userAgent, userAgentBrands: null, userAgentPlatform: null });
const asked = (userAgent: string) => ({ userAgent, brands: null, platform: null });

describe("following the client's version", () => {
    beforeEach(() => update.mockClear());

    it("records a newer version of the same client", async () => {
        expect(describeClient(desktop("0.1.40"), null, null)).toMatchObject({
            browser: "Polaris Desktop",
            browserVersion: "0.1.40"
        });
        await followClientVersion("s1", recorded(desktop("0.1.1")), asked(desktop("0.1.40")));
        expect(update).toHaveBeenCalledWith({
            where: { sessionId: "s1" },
            data: { userAgent: desktop("0.1.40"), userAgentBrands: null, userAgentPlatform: null }
        });
    });

    it("writes nothing when nothing changed", async () => {
        await followClientVersion("s1", recorded(desktop("0.1.40")), asked(desktop("0.1.40")));
        expect(update).not.toHaveBeenCalled();
    });

    it("never takes on a different client as the session's own", async () => {
        await followClientVersion("s1", recorded(desktop("0.1.40")), asked(firefox));
        expect(update).not.toHaveBeenCalled();
    });

    it("takes the phone app's word over a record taken without its marker", async () => {
        // The live case: a service worker's fetch reached the server first and
        // the session read as Android WebView on the device list.
        await followClientVersion(
            "s1",
            { userAgent: webview, userAgentBrands: WEBVIEW_BRANDS, userAgentPlatform: null },
            { userAgent: app, brands: WEBVIEW_BRANDS, platform: null }
        );
        expect(update).toHaveBeenCalledWith({
            where: { sessionId: "s1" },
            data: { userAgent: app, userAgentBrands: WEBVIEW_BRANDS, userAgentPlatform: null }
        });
    });

    it("never puts the marker on a WebView that is not the same agent", async () => {
        await followClientVersion("s1", recorded(webview.replace("Chrome/157", "Chrome/156")), asked(app));
        expect(update).not.toHaveBeenCalled();
    });
});

const WEBVIEW_BRANDS = '"Not-A.Brand";v="99", "Android WebView";v="157", "Chromium";v="157"';
const webview =
    "Mozilla/5.0 (Linux; Android 15; 23129RN51X Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8103.50 Mobile Safari/537.36";
const app = `${webview} PolarisMobile/0.1.13 (Android)`;

describe("the phone app's marker", () => {
    it("reads a session recorded without it as the app the session was opened in", async () => {
        const { sessionClient } = await import("@/lib/session-device");
        const row = { userAgent: app, state: { userAgent: webview, userAgentBrands: WEBVIEW_BRANDS, userAgentPlatform: null } };
        expect(sessionClient(row).browser).toBe("Polaris Mobile");
    });

    it("leaves a different browser alone", async () => {
        const { withAppMarker } = await import("@/lib/session-row");
        expect(withAppMarker(app, firefox)).toBe(firefox);
        expect(withAppMarker(webview, webview)).toBe(webview);
        expect(withAppMarker(null, webview)).toBe(webview);
        expect(withAppMarker(app, null)).toBeNull();
    });
});
