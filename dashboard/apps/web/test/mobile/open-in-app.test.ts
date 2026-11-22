/**
 * A Polaris link followed in a browser, handed to the Polaris app on the device:
 * only where the account has that app, only on arrival from outside, once.
 */

import { describe, expect, it } from "vitest";
import { appLink, appTarget, arrivedFromOutside, isIphoneApp } from "@/lib/open-in-app";

const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const PHONE_APP = `${ANDROID_CHROME} PolarisMobile/0.1.6`;
const WINDOWS_CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DESKTOP_APP = `${WINDOWS_CHROME.replace("Safari/537.36", "Polaris/1.2.0 Electron/33.0.0 Safari/537.36")}`;
const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const BOTH = { phone: true, desktop: true };

describe("which app a link is handed to", () => {
    it("is the phone app on Android and the desktop app on a computer", () => {
        expect(appTarget(ANDROID_CHROME, BOTH)).toBe("phone");
        expect(appTarget(WINDOWS_CHROME, BOTH)).toBe("desktop");
    });

    it("is none where the account has not signed in to that app", () => {
        expect(appTarget(ANDROID_CHROME, { phone: false, desktop: true })).toBeNull();
        expect(appTarget(WINDOWS_CHROME, { phone: true, desktop: false })).toBeNull();
    });

    it("is none inside one of the apps already", () => {
        expect(appTarget(PHONE_APP, BOTH)).toBeNull();
        expect(appTarget(DESKTOP_APP, BOTH)).toBeNull();
        expect(appTarget(`${IPHONE} PolarisMobile/0.1.2 (iOS)`, { ...BOTH, iphone: true })).toBeNull();
    });

    it("is the iPhone app on an iPhone, only where the account signed in to that app", () => {
        expect(appTarget(IPHONE, { ...BOTH, iphone: true })).toBe("iphone");
        // Signed in to the Android app only: nothing to open on an iPhone.
        expect(appTarget(IPHONE, BOTH)).toBeNull();
        expect(appLink("iphone", "https://polaris.example.com", "/chat")).toBe(
            "polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=%2Fchat"
        );
    });

    it("tells the iPhone app's sessions from the Android app's", () => {
        expect(isIphoneApp(`${IPHONE} PolarisMobile/0.1.2 (iOS)`)).toBe(true);
        expect(isIphoneApp(PHONE_APP)).toBe(false);
        expect(isIphoneApp(IPHONE)).toBe(false);
        expect(isIphoneApp(null)).toBe(false);
    });
});

describe("when a load is handed over", () => {
    const base = { origin: "https://polaris.example.com", path: "/chat/general", navigation: "navigate", tried: false };

    it("is a page reached from outside Polaris", () => {
        expect(arrivedFromOutside({ ...base, referrer: "" })).toBe(true);
        expect(arrivedFromOutside({ ...base, referrer: "https://mail.example.org/inbox" })).toBe(true);
    });

    it("is never a move inside Polaris, a reload, a second try or a sign-in", () => {
        expect(arrivedFromOutside({ ...base, referrer: "https://polaris.example.com/home" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", navigation: "reload" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", navigation: "back_forward" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", tried: true })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", path: "/login?next=/chat" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", path: "/api/files/1" })).toBe(false);
    });

    it("is never the app a sign-in moved on to without a page load", () => {
        // The visit started at the sign-in screen; the router has since moved it.
        expect(arrivedFromOutside({ ...base, referrer: "", landing: "/oauth/login?redirect=%2Fvault" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", landing: "/oauth/2fa" })).toBe(false);
        expect(arrivedFromOutside({ ...base, referrer: "", landing: "/chat/general" })).toBe(true);
    });
});

describe("the link", () => {
    it("names only the page, in the form both apps read", () => {
        expect(appLink("desktop", "https://polaris.example.com", "/chat/general?m=1")).toBe(
            "polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=%2Fchat%2Fgeneral%3Fm%3D1"
        );
    });

    it("opens the Android app by package, falling back to this page rather than the store", () => {
        const link = appLink("phone", "https://polaris.example.com", "/chat");
        expect(link.startsWith("intent://open?server=https%3A%2F%2Fpolaris.example.com&path=%2Fchat#Intent;")).toBe(true);
        expect(link).toContain(";scheme=polaris;package=app.polaris.mobile;");
        expect(link).toContain(";S.browser_fallback_url=https%3A%2F%2Fpolaris.example.com%2Fchat;end");
    });
});
