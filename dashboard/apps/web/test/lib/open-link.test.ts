// @vitest-environment jsdom

/**
 * Every outside link opens through one path: the phone app's browser when the
 * app offers it, a new tab otherwise, and never anything but the web and mail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { framedOpenHref, openLink, openableUrl } from "@/lib/open-link";

afterEach(() => {
    delete (window as { polarisMobile?: unknown }).polarisMobile;
    vi.restoreAllMocks();
});

describe("openableUrl", () => {
    it("takes the web and mail, resolved against the page", () => {
        expect(openableUrl("https://example.com/a", "https://p.test/")?.href).toBe("https://example.com/a");
        expect(openableUrl("/drive", "https://p.test/x")?.href).toBe("https://p.test/drive");
        expect(openableUrl("mailto:a@example.com", "https://p.test/")?.protocol).toBe("mailto:");
    });

    it("refuses every other scheme", () => {
        for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "intent://x", "polaris://x"]) {
            expect(openableUrl(href, "https://p.test/")).toBeNull();
        }
    });
});

describe("framedOpenHref", () => {
    it("reads an absolute web or mail address", () => {
        expect(framedOpenHref("https://example.com/a")).toBe("https://example.com/a");
        expect(framedOpenHref("MAILTO:a@example.com")).toBe("mailto:a@example.com");
    });

    it("refuses anything else a frame might post", () => {
        expect(framedOpenHref("/api/admin")).toBeNull();
        expect(framedOpenHref("javascript:alert(1)")).toBeNull();
        expect(framedOpenHref({ href: "https://example.com" })).toBeNull();
        expect(framedOpenHref(`https://example.com/${"a".repeat(20_001)}`)).toBeNull();
    });
});

describe("openLink", () => {
    it("opens a new tab in a browser", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        expect(openLink("https://example.com/a")).toBe(true);
        expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
    });

    it("hands an outside link to the phone app when it can take one", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        const openExternal = vi.fn();
        (window as { polarisMobile?: unknown }).polarisMobile = { openExternal };
        expect(openLink("https://example.com/a")).toBe(true);
        expect(openLink("mailto:a@example.com")).toBe(true);
        expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
        expect(openExternal).toHaveBeenCalledWith("mailto:a@example.com");
        expect(open).not.toHaveBeenCalled();
    });

    it("keeps a link to this Polaris in the app, and falls back on an older app", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        const openExternal = vi.fn();
        (window as { polarisMobile?: unknown }).polarisMobile = { openExternal };
        openLink("/drive");
        expect(openExternal).not.toHaveBeenCalled();
        (window as { polarisMobile?: unknown }).polarisMobile = { platform: () => "android" };
        openLink("https://example.com/b");
        expect(open).toHaveBeenCalledTimes(2);
    });

    it("opens nothing for another scheme", () => {
        const open = vi.spyOn(window, "open").mockReturnValue(null);
        expect(openLink("javascript:alert(1)")).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });
});
