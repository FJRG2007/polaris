/**
 * Which Polaris app a request comes from, read from the User-Agent each app
 * actually sends, and whether it is too old for sealed chat.
 */

import { describe, expect, it } from "vitest";
import { SEALED_CHAT_MINIMUM, compareVersions, polarisAppOf, sealedAppOutdated } from "@/lib/chat/e2ee/client-version";

// As `AppAgent.java` builds it: the WebView's own agent, then the app.
const android = (version: string) =>
    `Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 PolarisMobile/${version} (Android)`;
// An Android build from before the platform was named in the agent.
const bareAndroid = (version: string) =>
    `Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 PolarisMobile/${version}`;
// WKWebView with `applicationNameForUserAgent` (`WebViewController.swift`).
const ios = (version: string) =>
    `Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) PolarisMobile/${version} (iOS)`;
// Electron's default agent: productName "Polaris" (clients/desktop/package.json) and the app version.
const desktop = (version: string) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Polaris/${version} Chrome/140.0.7339.41 Electron/44.3.0 Safari/537.36`;
const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

describe("polarisAppOf", () => {
    it("names each Polaris app and its version", () => {
        expect(polarisAppOf(android("0.1.15"))).toEqual({ app: "android", version: "0.1.15" });
        expect(polarisAppOf(bareAndroid("0.1.3"))).toEqual({ app: "android", version: "0.1.3" });
        expect(polarisAppOf(ios("0.1.4"))).toEqual({ app: "ios", version: "0.1.4" });
        expect(polarisAppOf(desktop("0.1.120"))).toEqual({ app: "desktop", version: "0.1.120" });
    });

    it("is null for a browser, an empty agent, or a Polaris/ token outside Electron", () => {
        expect(polarisAppOf(chrome)).toBeNull();
        expect(polarisAppOf("")).toBeNull();
        expect(polarisAppOf(null)).toBeNull();
        expect(polarisAppOf(`${chrome.replace("Chrome/", "Polaris/0.1.1 Chrome/")}`)).toBeNull();
    });

    it("reads no further than an app's agent could reach", () => {
        expect(polarisAppOf(`${"x".repeat(2000)} PolarisMobile/0.1.1 (Android)`)).toBeNull();
    });
});

describe("compareVersions", () => {
    it("compares part by part, numerically, a missing part being 0", () => {
        expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
        expect(compareVersions("0.1.56", "0.1.56")).toBe(0);
        expect(compareVersions("0.1", "0.1.0")).toBe(0);
        expect(compareVersions("1.0", "0.9.99")).toBe(1);
    });
});

describe("sealedAppOutdated", () => {
    it("holds back an app older than its minimum, naming the minimum", () => {
        expect(sealedAppOutdated(android("0.1.14"))).toEqual({ app: "android", version: "0.1.14", minimum: SEALED_CHAT_MINIMUM.android });
        expect(sealedAppOutdated(bareAndroid("0.1.3"))?.app).toBe("android");
        expect(sealedAppOutdated(ios("0.1.3"))).toEqual({ app: "ios", version: "0.1.3", minimum: SEALED_CHAT_MINIMUM.ios });
        expect(sealedAppOutdated(desktop("0.1.55"))).toEqual({ app: "desktop", version: "0.1.55", minimum: SEALED_CHAT_MINIMUM.desktop });
    });

    it("lets through the minimum itself, anything newer, and anything that is not an app", () => {
        expect(sealedAppOutdated(android(SEALED_CHAT_MINIMUM.android))).toBeNull();
        expect(sealedAppOutdated(ios(SEALED_CHAT_MINIMUM.ios))).toBeNull();
        expect(sealedAppOutdated(desktop(SEALED_CHAT_MINIMUM.desktop))).toBeNull();
        expect(sealedAppOutdated(desktop("0.1.120"))).toBeNull();
        expect(sealedAppOutdated(chrome)).toBeNull();
        expect(sealedAppOutdated(undefined)).toBeNull();
    });
});
