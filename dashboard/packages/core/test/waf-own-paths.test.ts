import { describe, expect, it } from "vitest";
import { isPolarisOwnPath, isStaticAssetPath, pathHasSegment } from "../src/waf-own-paths.js";

describe("isPolarisOwnPath", () => {
    it("knows Polaris's own routes and files", () => {
        expect(isPolarisOwnPath("/logos/apps/phpmyadmin.svg")).toBe(true);
        expect(isPolarisOwnPath("/_next/static/chunks/main.js")).toBe(true);
        expect(isPolarisOwnPath("/apps/marketplace?q=phpmyadmin")).toBe(true);
        expect(isPolarisOwnPath("/robots.txt")).toBe(true);
    });

    it("does not know a path Polaris never serves", () => {
        expect(isPolarisOwnPath("/phpmyadmin/")).toBe(false);
        expect(isPolarisOwnPath("/wp-login.php")).toBe(false);
        expect(isPolarisOwnPath("")).toBe(false);
        expect(isPolarisOwnPath(null)).toBe(false);
    });

    it("never trusts a hidden file under a real route", () => {
        expect(isPolarisOwnPath("/api/.env")).toBe(false);
        expect(isPolarisOwnPath("/admin/.git/config")).toBe(false);
        expect(isPolarisOwnPath("/.well-known/security.txt")).toBe(true);
    });

    it("never trusts a path that climbs out of a route", () => {
        expect(isPolarisOwnPath("/logos/../phpmyadmin")).toBe(false);
        expect(isPolarisOwnPath("/logos/%2e%2e/phpmyadmin")).toBe(false);
    });
});

describe("isStaticAssetPath", () => {
    it("names pictures, fonts, styles and media", () => {
        for (const path of ["/a/b.svg", "/x.PNG", "/f.woff2", "/s.css?v=1", "/v.mp4"]) {
            expect(isStaticAssetPath(path)).toBe(true);
        }
    });

    it("does not name programs or secrets", () => {
        for (const path of ["/wp-login.php", "/.env", "/config.json", "/index", "/.svg"]) {
            expect(isStaticAssetPath(path)).toBe(false);
        }
    });
});

describe("pathHasSegment", () => {
    it("matches a whole segment, or a file stem with a program's extension", () => {
        expect(pathHasSegment("/phpMyAdmin/", "/phpmyadmin")).toBe(true);
        expect(pathHasSegment("/phpmyadmin", "/phpmyadmin")).toBe(true);
        expect(pathHasSegment("/wp-login.php", "/wp-login")).toBe(true);
        expect(pathHasSegment("/x/.git/config", "/.git")).toBe(true);
    });

    it("does not match inside a longer name or a picture", () => {
        expect(pathHasSegment("/.github/", "/.git")).toBe(false);
        expect(pathHasSegment("/logos/phpmyadmin.svg", "/phpmyadmin")).toBe(false);
        expect(pathHasSegment("/phpmyadmin-docs", "/phpmyadmin")).toBe(false);
    });
});
