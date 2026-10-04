/**
 * Handing out the CLI from this Polaris: the install scripts carry the address
 * they were fetched from - checked to a strict shape first, because a shell
 * runs them - and every file carries the digest the installers verify.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fillScript, isCliFile, requestOrigin, URL_PLACEHOLDER } from "@/lib/cli/distribution";

vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: async () => "https://configured.example.com"
}));

const { GET } = await import("@/app/cli/[file]/route");

const headers = (values: Record<string, string>) => new Headers(values);

describe("the address written into a script", () => {
    it("is the one the request came in on, past the proxy", () => {
        expect(
            requestOrigin(
                headers({
                    host: "web:3000",
                    "x-forwarded-host": "polaris.example.com",
                    "x-forwarded-proto": "https"
                })
            )
        ).toBe("https://polaris.example.com");
        expect(requestOrigin(headers({ host: "polaris.local" }))).toBe("http://polaris.local");
        expect(requestOrigin(headers({ host: "10.0.0.5:8080", "x-forwarded-proto": "http" }))).toBe(
            "http://10.0.0.5:8080"
        );
        expect(requestOrigin(headers({ host: "[::1]:3000" }))).toBe("http://[::1]:3000");
    });

    it("is refused when it carries anything a shell would read as more than text", () => {
        for (const host of [
            "evil.com$(id)",
            "evil.com`id`",
            'evil.com";rm -rf ~;"',
            "evil.com/path",
            "evil.com:99999999",
            "a b",
            "",
            "0.0.0.0:3000"
        ]) {
            expect(requestOrigin(headers({ host }))).toBeNull();
        }
        expect(
            requestOrigin(
                headers({ host: "polaris.example.com", "x-forwarded-proto": "javascript" })
            )
        ).toBeNull();
    });

    it("replaces every placeholder", () => {
        expect(fillScript(`a=${URL_PLACEHOLDER} b=${URL_PLACEHOLDER}`, "https://p.example/")).toBe(
            "a=https://p.example b=https://p.example"
        );
    });

    it("serves only the three files", () => {
        expect(isCliFile("install.sh")).toBe(true);
        expect(isCliFile("install.ps1")).toBe(true);
        expect(isCliFile("polaris.mjs")).toBe(true);
        expect(isCliFile("../package.json")).toBe(false);
        expect(isCliFile("constructor")).toBe(false);
    });
});

describe("GET /cli/[file]", () => {
    const fetchFile = (file: string, values: Record<string, string>) =>
        GET(new Request(`https://polaris.example.com/cli/${file}`, { headers: values }), {
            params: Promise.resolve({ file })
        });

    it("serves the shell installer with this Polaris filled in and its digest beside it", async () => {
        const response = await fetchFile("install.sh", {
            host: "polaris.example.com",
            "x-forwarded-proto": "https"
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('POLARIS_URL="${POLARIS_URL:-https://polaris.example.com}"');
        expect(body).not.toContain(URL_PLACEHOLDER);
        expect(response.headers.get("x-content-sha256")).toBe(
            createHash("sha256").update(body).digest("hex")
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("serves the PowerShell installer the same way", async () => {
        const body = await (
            await fetchFile("install.ps1", {
                host: "polaris.example.com",
                "x-forwarded-proto": "https"
            })
        ).text();
        expect(body).toContain('"https://polaris.example.com"');
        expect(body).toContain("Install-PolarisCli");
    });

    it("falls back to the configured address when the request's own is not usable", async () => {
        const body = await (await fetchFile("install.sh", { host: "evil.com$(id)" })).text();
        expect(body).toContain("https://configured.example.com");
        expect(body).not.toContain("$(id)");
    });

    it("answers 404 for anything else", async () => {
        expect((await fetchFile("secrets.env", { host: "polaris.example.com" })).status).toBe(404);
    });
});
