/**
 * The navigation allowlist: only the configured Polaris is loaded in a window,
 * other web addresses go to the system browser, and nothing else goes anywhere.
 */

import { describe, expect, it } from "vitest";
import { allowPermission } from "@/main/permissions";
import { classifyNavigation, isSafeExternalUrl, isServerUrl, serverPath } from "@/main/navigation";

const SERVER = "https://polaris.example.com";

describe("classifyNavigation", () => {
    it("allows the configured origin, on any path", () => {
        expect(classifyNavigation("https://polaris.example.com/home", SERVER)).toBe("allow");
        expect(classifyNavigation("https://polaris.example.com/apps/deploy?service=1#logs", SERVER)).toBe("allow");
        expect(classifyNavigation("https://POLARIS.example.com/", SERVER)).toBe("allow");
    });

    it("sends another origin to the system browser - scheme, host and port all count", () => {
        expect(classifyNavigation("https://github.com/settings/tokens", SERVER)).toBe("external");
        expect(classifyNavigation("http://polaris.example.com/home", SERVER)).toBe("external");
        expect(classifyNavigation("https://polaris.example.com:8443/", SERVER)).toBe("external");
        expect(classifyNavigation("https://evil.polaris.example.com/", SERVER)).toBe("external");
        expect(classifyNavigation("https://polaris.example.com.evil.test/", SERVER)).toBe("external");
        expect(classifyNavigation("https://polaris.example.com@evil.test/", SERVER)).toBe("external");
    });

    it("opens a mail link in the mail app", () => {
        expect(classifyNavigation("mailto:someone@example.com", SERVER)).toBe("external");
    });

    it("blocks everything that is not a web address", () => {
        for (const url of [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ms-settings:privacy",
            "\\\\attacker\\share",
            "not a url",
            ""
        ]) {
            expect(classifyNavigation(url, SERVER)).toBe("block");
        }
    });
});

describe("isServerUrl and isSafeExternalUrl", () => {
    it("tells the server from the web from the rest", () => {
        expect(isServerUrl("https://polaris.example.com/x", SERVER)).toBe(true);
        expect(isServerUrl("https://example.com/x", SERVER)).toBe(false);
        expect(isSafeExternalUrl("https://example.com/x")).toBe(true);
        expect(isSafeExternalUrl("httpevil://example.com")).toBe(false);
        expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    });
});

describe("serverPath", () => {
    it("resolves a path on the server", () => {
        expect(serverPath("/apps/deploy/p1/logs?service=s1", SERVER)).toBe(
            "https://polaris.example.com/apps/deploy/p1/logs?service=s1"
        );
    });

    it("refuses anything that could leave the origin", () => {
        expect(serverPath("//evil.test/x", SERVER)).toBeNull();
        expect(serverPath("/\\evil.test/x", SERVER)).toBeNull();
        expect(serverPath("https://evil.test/x", SERVER)).toBeNull();
        expect(serverPath("javascript:alert(1)", SERVER)).toBeNull();
        expect(serverPath("apps/deploy", SERVER)).toBeNull();
    });
});

describe("allowPermission", () => {
    it("grants notifications, the clipboard, the microphone and camera, and full screen to the server only", () => {
        for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write", "media", "fullscreen"]) {
            expect(allowPermission(permission, "https://polaris.example.com/chat", SERVER)).toBe(true);
            expect(allowPermission(permission, "https://evil.test/", SERVER)).toBe(false);
        }
    });

    it("denies everything else, and everything before a server is set", () => {
        for (const permission of ["geolocation", "midi", "hid", "serial", "usb", "openExternal", "display-capture"]) {
            expect(allowPermission(permission, "https://polaris.example.com/", SERVER)).toBe(false);
        }
        expect(allowPermission("notifications", "https://polaris.example.com/", null)).toBe(false);
        expect(allowPermission("notifications", "not a url", SERVER)).toBe(false);
    });
});
