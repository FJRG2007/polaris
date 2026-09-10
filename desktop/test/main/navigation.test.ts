/**
 * The navigation allowlist: only the configured Polaris is loaded in a window,
 * other web addresses go to the system browser, and nothing else goes anywhere.
 */

import { describe, expect, it } from "vitest";
import { allowPermission } from "@/main/permissions";
import {
    backIndex,
    classifyNavigation,
    isSafeExternalUrl,
    isServerUrl,
    mainFrameStep,
    serverPath,
    startsProviderTrip
} from "@/main/navigation";

const SERVER = "https://polaris.example.com";

describe("classifyNavigation", () => {
    it("allows the configured origin, on any path", () => {
        expect(classifyNavigation("https://polaris.example.com/home", SERVER)).toBe("allow");
        expect(
            classifyNavigation("https://polaris.example.com/apps/deploy?service=1#logs", SERVER)
        ).toBe("allow");
        expect(classifyNavigation("https://POLARIS.example.com/", SERVER)).toBe("allow");
    });

    it("sends another origin to the system browser - scheme, host and port all count", () => {
        expect(classifyNavigation("https://github.com/settings/tokens", SERVER)).toBe("external");
        expect(classifyNavigation("http://polaris.example.com/home", SERVER)).toBe("external");
        expect(classifyNavigation("https://polaris.example.com:8443/", SERVER)).toBe("external");
        expect(classifyNavigation("https://evil.polaris.example.com/", SERVER)).toBe("external");
        expect(classifyNavigation("https://polaris.example.com.evil.test/", SERVER)).toBe(
            "external"
        );
        expect(classifyNavigation("https://polaris.example.com@evil.test/", SERVER)).toBe(
            "external"
        );
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

describe("startsProviderTrip", () => {
    it("is the Polaris routes that link an outside account or sign in with one", () => {
        expect(
            startsProviderTrip("https://polaris.example.com/api/connections/google/link", SERVER)
        ).toBe(true);
        expect(
            startsProviderTrip(
                "https://polaris.example.com/api/connections/google/link?scope=mail",
                SERVER
            )
        ).toBe(true);
        expect(
            startsProviderTrip(
                "https://polaris.example.com/api/connections/discord/signin?redirect=%2Fdrive",
                SERVER
            )
        ).toBe(true);
    });

    it("is nothing else, and nothing on another origin", () => {
        expect(startsProviderTrip("https://polaris.example.com/account/connections", SERVER)).toBe(
            false
        );
        expect(
            startsProviderTrip(
                "https://polaris.example.com/api/connections/google/callback",
                SERVER
            )
        ).toBe(false);
        expect(
            startsProviderTrip("https://polaris.example.com/api/connections/google/link/x", SERVER)
        ).toBe(false);
        expect(startsProviderTrip("https://evil.test/api/connections/google/link", SERVER)).toBe(
            false
        );
    });
});

describe("mainFrameStep", () => {
    const LINK = "https://polaris.example.com/api/connections/google/link";
    const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

    it("keeps the window on the Polaris outside a round trip", () => {
        expect(mainFrameStep("https://polaris.example.com/home", SERVER, false)).toEqual({
            verdict: "allow",
            trip: false
        });
        expect(mainFrameStep(GOOGLE, SERVER, false)).toEqual({ verdict: "external", trip: false });
        expect(mainFrameStep("file:///etc/passwd", SERVER, false)).toEqual({
            verdict: "block",
            trip: false
        });
    });

    it("follows a round trip the Polaris starts out to the provider and back", () => {
        const start = mainFrameStep(LINK, SERVER, false);
        expect(start).toEqual({ verdict: "allow", trip: true });
        const out = mainFrameStep(GOOGLE, SERVER, start.trip);
        expect(out).toEqual({ verdict: "allow", trip: true });
        const other = mainFrameStep(
            "https://polaris.public.example/api/connections/google/callback?code=c",
            SERVER,
            out.trip
        );
        expect(other).toEqual({ verdict: "allow", trip: true });
        expect(
            mainFrameStep(
                "https://polaris.example.com/account/connections?connection=linked",
                SERVER,
                other.trip
            )
        ).toEqual({
            verdict: "allow",
            trip: true
        });
    });

    it("still blocks what is not a web address during a round trip", () => {
        expect(mainFrameStep("javascript:alert(1)", SERVER, true)).toEqual({
            verdict: "block",
            trip: true
        });
        expect(mainFrameStep("ms-settings:privacy", SERVER, true)).toEqual({
            verdict: "block",
            trip: true
        });
    });
});

describe("backIndex", () => {
    it("steps back one page on the Polaris", () => {
        expect(backIndex([`${SERVER}/home`, `${SERVER}/drive`], 1, SERVER)).toBe(0);
    });

    it("from a provider's page, goes back to the last page of the Polaris", () => {
        const history = [
            `${SERVER}/home`,
            `${SERVER}/account/connections`,
            "https://accounts.google.com/a",
            "https://accounts.google.com/b"
        ];
        expect(backIndex(history, 3, SERVER)).toBe(1);
    });

    it("never steps from the Polaris onto another origin, and has nowhere to go at the start", () => {
        expect(
            backIndex(["https://accounts.google.com/a", `${SERVER}/home`], 1, SERVER)
        ).toBeNull();
        expect(backIndex([`${SERVER}/home`], 0, SERVER)).toBeNull();
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
    it("grants notifications, the clipboard, the microphone and camera, full screen and screen sharing to the server only", () => {
        for (const permission of [
            "notifications",
            "clipboard-read",
            "clipboard-sanitized-write",
            "media",
            "fullscreen",
            "display-capture"
        ]) {
            expect(allowPermission(permission, "https://polaris.example.com/chat", SERVER)).toBe(
                true
            );
            expect(allowPermission(permission, "https://evil.test/", SERVER)).toBe(false);
        }
    });

    it("denies everything else, and everything before a server is set", () => {
        for (const permission of ["geolocation", "midi", "hid", "serial", "usb", "openExternal"]) {
            expect(allowPermission(permission, "https://polaris.example.com/", SERVER)).toBe(false);
        }
        expect(allowPermission("notifications", "https://polaris.example.com/", null)).toBe(false);
        expect(allowPermission("notifications", "not a url", SERVER)).toBe(false);
    });
});
