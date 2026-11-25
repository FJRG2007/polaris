import { describe, expect, it } from "vitest";
import { typedUrl } from "../src/typed-url";

describe("an address typed into a search", () => {
    it.each([
        ["https://example.com/a?b=1", "https://example.com/a?b=1", "example.com"],
        ["HTTP://Example.com", "http://example.com/", "example.com"],
        ["example.com", "https://example.com/", "example.com"],
        ["github.com/owner/repo", "https://github.com/owner/repo", "github.com"],
        ["sub.example.co.uk:8443/x", "https://sub.example.co.uk:8443/x", "sub.example.co.uk:8443"],
        ["localhost", "http://localhost/", "localhost"],
        ["localhost:3000/api", "http://localhost:3000/api", "localhost:3000"],
        ["192.168.1.10", "http://192.168.1.10/", "192.168.1.10"],
        ["10.0.0.1:8080", "http://10.0.0.1:8080/", "10.0.0.1:8080"],
        ["[::1]:8080", "http://[::1]:8080/", "[::1]:8080"],
        ["mailto:someone@example.com", "mailto:someone@example.com", "someone@example.com"],
        ["  example.org  ", "https://example.org/", "example.org"]
    ])("opens %s", (text, url, host) => {
        expect(typedUrl(text)).toEqual({ url, host });
    });

    it.each([
        "",
        "1.5",
        "42",
        "3.14159",
        "grand theft auto",
        "example .com",
        "open example.com",
        "file:///C:/Windows/System32",
        "file://server/share",
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<b>x</b>",
        "vbscript:msgbox",
        "steam://run/271590",
        "ms-settings:display",
        "example.c",
        "999.1.1.1",
        "https://",
        "https://user:pass@example.com",
        "mailto:nobody",
        "gta",
        "C:\Program Files"
    ])("does not open %j", (text) => {
        expect(typedUrl(text)).toBeNull();
    });

    it("never answers anything but http, https or mailto", () => {
        for (const text of ["example.com", "localhost:1", "mailto:a@b.cd", "https://x.io"]) {
            expect(typedUrl(text)?.url).toMatch(/^(https?:|mailto:)/);
        }
    });

    it("refuses text longer than any address worth opening", () => {
        expect(typedUrl(`example.com/${"a".repeat(3000)}`)).toBeNull();
    });
});
