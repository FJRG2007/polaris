import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "fixture-secret-fixture-secret-0000" })
}));

const lookups = vi.hoisted(() => ({
    framedArtifact: vi.fn(),
    readArtifactVersion: vi.fn()
}));
vi.mock("@/lib/agents/session-artifacts", () => lookups);

import * as pass from "@/lib/agents/artifacts/frame-pass";
import * as files from "@/lib/agents/artifacts/artifact-files";
import { serveFramed } from "@/lib/agents/artifacts/serve-artifact";

const PAGE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "user-fixture-1";

describe("a page read by path", () => {
    it("takes a plain path inside the folder and refuses a step out", () => {
        expect(files.artifactFramePath(["report", "charts", "a b.png"])).toBe("report/charts/a b.png");
        expect(files.artifactFramePath(["report", "..", "secret.txt"])).toBeNull();
        expect(files.artifactFramePath([".."])).toBeNull();
        expect(files.artifactFramePath(["..%2F"])).toBeNull();
        expect(files.artifactFramePath(["a/../b"])).toBeNull();
        expect(files.artifactFramePath(["a\\..\\b"])).toBeNull();
        expect(files.artifactFramePath([".git", "config"])).toBeNull();
        expect(files.artifactFramePath(["", "x"])).toBeNull();
        expect(files.artifactFramePath(["x\u0000"])).toBeNull();
        expect(files.artifactFramePath([])).toBeNull();
    });

    it("reaches the page's own folder for whoever was given the page alone", () => {
        expect(files.frameReaches("report/index.html", "report/style.css", false)).toBe(true);
        expect(files.frameReaches("report/index.html", "report/img/a.png", false)).toBe(true);
        expect(files.frameReaches("report/index.html", "notes.md", false)).toBe(false);
        expect(files.frameReaches("report/index.html", "reportx/a.png", false)).toBe(false);
        expect(files.frameReaches("report/index.html", "notes.md", true)).toBe(true);
        expect(files.frameReaches("index.html", "img/a.png", false)).toBe(true);
    });

    it("names each part of the path encoded, so a relative reference resolves beside it", () => {
        const url = files.framedUrl("/api/agents/artifacts/link/tok/f", "report/a b#1.html", 3);
        expect(url).toBe("/api/agents/artifacts/link/tok/f/report/a%20b%231.html?v=3");
        expect(new URL("img/x.png", `https://polaris.example${url}`).pathname).toBe(
            "/api/agents/artifacts/link/tok/f/report/img/x.png"
        );
    });

    it("serves what a framed page loads under the same sandbox, with its own files allowed", () => {
        const headers = files.artifactHeaders({
            mediaType: "image/png",
            name: "a.png",
            size: 3,
            download: false,
            immutable: false,
            framed: true
        });
        expect(headers["content-security-policy"]).toContain("sandbox allow-scripts allow-popups");
        expect(headers["content-security-policy"]).toContain("img-src 'self'");
        expect(headers["content-security-policy"]).toContain("connect-src 'none'");
        expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
        const plain = files.artifactHeaders({ mediaType: "image/png", name: "a.png", size: 3, download: false, immutable: false });
        expect(plain["content-security-policy"]).toBe(files.ARTIFACT_CSP);
        expect(plain["cross-origin-resource-policy"]).toBe("same-origin");
    });
});

describe("the frame pass", () => {
    it("names who it was minted for, for that page only, until it runs out", () => {
        const now = 1_800_000_000_000;
        const minted = pass.mintFramePass(PAGE, USER, now);
        expect(pass.readFramePass(PAGE, minted, now + 1000)).toBe(USER);
        expect(pass.readFramePass(OTHER, minted, now + 1000)).toBeNull();
        expect(pass.readFramePass(PAGE, minted, now + pass.FRAME_PASS_TTL_MS + 1)).toBeNull();
    });

    it("refuses one changed by hand", () => {
        const now = 1_800_000_000_000;
        const [payload, signature] = pass.mintFramePass(PAGE, USER, now).split(".") as [string, string];
        const forged = Buffer.from(`${PAGE}:someone-else:${now + 10_000}`, "utf8").toString("base64url");
        expect(pass.readFramePass(PAGE, `${forged}.${signature}`, now)).toBeNull();
        expect(pass.readFramePass(PAGE, `${payload}.${"A".repeat(signature.length)}`, now)).toBeNull();
        expect(pass.readFramePass(PAGE, "nonsense", now)).toBeNull();
    });
});

describe("serving by path", () => {
    beforeEach(() => {
        lookups.framedArtifact.mockReset();
        lookups.readArtifactVersion.mockReset();
    });

    const request = (query = "") => new Request(`https://polaris.example/x${query}`);

    it("never looks a path up for a reader without the page, or for a step out", async () => {
        expect((await serveFramed(request(), null, ["a.png"], false)).status).toBe(404);
        expect((await serveFramed(request(), PAGE, ["..", "a.png"], true)).status).toBe(404);
        expect(lookups.framedArtifact).not.toHaveBeenCalled();
    });

    it("says not found for a file the reader does not reach", async () => {
        lookups.framedArtifact.mockResolvedValue(null);
        expect((await serveFramed(request(), PAGE, ["notes.md"], false)).status).toBe(404);
        expect(lookups.framedArtifact).toHaveBeenCalledWith(PAGE, "notes.md", false, null);
        expect(lookups.readArtifactVersion).not.toHaveBeenCalled();
    });

    it("streams a file beside the page under the frame's policy", async () => {
        lookups.framedArtifact.mockResolvedValue({ artifactId: OTHER, version: null });
        lookups.readArtifactVersion.mockResolvedValue({
            name: "a.png",
            mediaType: "image/png",
            size: 3,
            version: 2,
            body: new Response("png").body
        });
        const response = await serveFramed(request("?v=4"), PAGE, ["report", "a.png"], true);
        expect(response.status).toBe(200);
        expect(lookups.framedArtifact).toHaveBeenCalledWith(PAGE, "report/a.png", true, 4);
        expect(lookups.readArtifactVersion).toHaveBeenCalledWith(OTHER, null);
        expect(response.headers.get("content-security-policy")).toBe(files.ARTIFACT_FRAME_CSP);
        expect(response.headers.get("cache-control")).toBe("private, no-cache");
        expect(await response.text()).toBe("png");
    });
});
