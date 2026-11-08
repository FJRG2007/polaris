/**
 * The route Firefox fetches the signed package from. It answers 404 while no
 * release carries one, 502 when GitHub's copy cannot be had or is not the size
 * of an extension, and otherwise the bytes with the type Firefox installs. The
 * package is downloaded once, not once per request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDownload } from "@/lib/app-releases";

const REPO = "example/polaris";
const XPI_URL = `https://github.com/${REPO}/releases/download/extension-v1/polaris-extension-firefox.xpi`;

const release = vi.hoisted(() => ({ value: null as AppDownload | null }));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_REPO: "example/polaris" }) }));
vi.mock("@/lib/app-releases", () => ({ extensionDownload: async () => release.value }));

const { GET } = await import("@/app/api/polaris/extension/firefox/route");
const { forgetPackage, XPI_CONTENT_TYPE, XPI_MAX_BYTES } = await import("@/lib/extension-package");

function withFiles(files: { name: string; url: string }[]): AppDownload {
    return {
        url: `https://github.com/${REPO}/releases/tag/extension-v1`,
        version: "1",
        files
    } as AppDownload;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    forgetPackage();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    release.value = withFiles([
        { name: "polaris-extension-chrome.zip", url: XPI_URL.replace(".xpi", ".zip") },
        { name: "polaris-extension-firefox.xpi", url: XPI_URL }
    ]);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("GET /api/polaris/extension/firefox", () => {
    it("answers 404 when the release carries no signed package", async () => {
        release.value = withFiles([{ name: "polaris-extension-firefox.zip", url: XPI_URL }]);
        expect((await GET()).status).toBe(404);
        release.value = null;
        expect((await GET()).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers 404 for an asset that is not this repository's release", async () => {
        release.value = withFiles([
            { name: "polaris-extension-firefox.xpi", url: "https://example.test/a.xpi" }
        ]);
        expect((await GET()).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("serves the package as the type Firefox installs, downloading it once", async () => {
        fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
        const [first, second] = await Promise.all([GET(), GET()]);
        const third = await GET();
        for (const response of [first, second, third]) {
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe(XPI_CONTENT_TYPE);
            expect(response.headers.get("content-length")).toBe("3");
        }
        expect(new Uint8Array(await third.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(XPI_URL);
    });

    it("answers 502 when GitHub refuses, and does not ask again straight away", async () => {
        fetchMock.mockImplementation(async () => new Response("no", { status: 503 }));
        expect((await GET()).status).toBe(502);
        expect((await GET()).status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("answers 502 when the download fails outright", async () => {
        fetchMock.mockRejectedValue(new Error("offline"));
        expect((await GET()).status).toBe(502);
    });

    it("answers 502 for a package larger than an extension", async () => {
        fetchMock.mockImplementation(
            async () =>
                new Response("x", { headers: { "content-length": String(XPI_MAX_BYTES + 1) } })
        );
        expect((await GET()).status).toBe(502);
    });

    it("answers 502 for an empty package", async () => {
        fetchMock.mockImplementation(async () => new Response(new Uint8Array(0)));
        expect((await GET()).status).toBe(502);
    });

    it("downloads again once the release names a new package", async () => {
        fetchMock.mockImplementation(async () => new Response(new Uint8Array([1])));
        await GET();
        const next = XPI_URL.replace("extension-v1", "extension-v2");
        release.value = withFiles([{ name: "polaris-extension-firefox.xpi", url: next }]);
        expect((await GET()).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1]?.[0]).toBe(next);
    });
});
