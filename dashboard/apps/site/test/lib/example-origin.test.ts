import { describe, expect, it } from "vitest";
import { EXAMPLE_ORIGIN, readerOrigin, withReaderOrigin } from "../../src/lib/example-origin";

describe("readerOrigin", () => {
    it("reads a bare host as https", () => {
        expect(readerOrigin("  polaris.home.lan ")).toBe("https://polaris.home.lan");
    });
    it("keeps http, a port and an IP address", () => {
        expect(readerOrigin("http://192.168.1.10:3000")).toBe("http://192.168.1.10:3000");
        expect(readerOrigin("http://192.168.1.10:3000/")).toBe("http://192.168.1.10:3000");
    });
    it("refuses what is not an origin", () => {
        for (const typed of [
            "",
            "javascript:alert(1)",
            "ftp://polaris.home.lan",
            "https://user:pass@polaris.home.lan",
            "https://polaris.home.lan/path",
            "https://polaris.home.lan?x=1",
            "polaris home",
            "<b>polaris</b>"
        ])
            expect(readerOrigin(typed), typed).toBeNull();
    });
});

describe("withReaderOrigin", () => {
    const sample = `curl ${EXAMPLE_ORIGIN}/api/v1/me -H "Host: polaris.example.com"`;
    it("leaves the placeholder without an address", () => {
        expect(withReaderOrigin(sample, null)).toBe(sample);
    });
    it("swaps the origin and the bare host", () => {
        expect(withReaderOrigin(sample, "http://10.0.0.5:3000")).toBe(
            'curl http://10.0.0.5:3000/api/v1/me -H "Host: 10.0.0.5:3000"'
        );
    });
    it("swaps inside highlighted markup", () => {
        const html = `<span class="s">"https://polaris.example.com/api"</span>`;
        expect(withReaderOrigin(html, "https://polaris.home.lan", true)).toBe(
            `<span class="s">"https://polaris.home.lan/api"</span>`
        );
    });
});
