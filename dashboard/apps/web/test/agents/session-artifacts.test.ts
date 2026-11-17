import { describe, expect, it } from "vitest";
import * as files from "@/lib/agents/artifacts/artifact-files";
import { deliverableArtifacts } from "@/lib/agents/artifacts/deliverables";
import { DELIVERABLES_PROMPT, PREVIEW_PROMPT } from "@/lib/agents/session-commands";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("the deliverables listing", () => {
    it("reads size, digest and path a line", () => {
        const listing = files.parseListing(`12\t${SHA_A}\treport.md\n3\t${SHA_B}\tcharts/one.png\n`);
        expect(listing).toEqual({
            files: [
                { path: "report.md", size: 12, sha256: SHA_A },
                { path: "charts/one.png", size: 3, sha256: SHA_B }
            ],
            truncated: false
        });
    });

    it("keeps spaces in a name, refuses a tab, and skips what does not parse", () => {
        const listing = files.parseListing(
            [`5\t${SHA_A}\ta b.txt`, `5\t${SHA_A}\ta\tb.txt`, "x\tnope\tc.txt", `4\t${SHA_A}\t../escape`, `4\t${SHA_A}\t.hidden/x`, `4\t${SHA_A}\t/abs`].join("\n")
        );
        expect(listing.files.map((file) => file.path)).toEqual(["a b.txt"]);
    });

    it("says when the folder held more than a capture takes", () => {
        const lines = Array.from({ length: files.ARTIFACT_MAX_FILES + 1 }, (_, index) => `1\t${SHA_A}\tf${index}.txt`);
        const listing = files.parseListing(lines.join("\n"));
        expect(listing.files).toHaveLength(files.ARTIFACT_MAX_FILES);
        expect(listing.truncated).toBe(true);
    });
});

describe("deliverablePath", () => {
    it("takes a relative path and refuses steps out, hidden parts and control characters", () => {
        expect(files.deliverablePath("docs/plan.md")).toBe("docs/plan.md");
        for (const bad of ["", "/etc/passwd", "a/../b", "./a", "a//b", ".git/config", "a\nb", "x".repeat(513)])
            expect(files.deliverablePath(bad)).toBeNull();
    });
});

describe("capturePlan", () => {
    it("versions new and changed files, notes removed and restored ones, leaves big ones out", () => {
        const plan = files.capturePlan(
            [
                { path: "same.md", size: 1, sha256: SHA_A },
                { path: "changed.md", size: 1, sha256: SHA_B },
                { path: "new.md", size: 1, sha256: SHA_A },
                { path: "back.md", size: 1, sha256: SHA_A },
                { path: "huge.bin", size: files.ARTIFACT_MAX_BYTES + 1, sha256: SHA_A }
            ],
            [
                { path: "same.md", sha256: SHA_A, removed: false },
                { path: "changed.md", sha256: SHA_A, removed: false },
                { path: "back.md", sha256: SHA_A, removed: true },
                { path: "gone.md", sha256: SHA_A, removed: false },
                { path: "long-gone.md", sha256: SHA_A, removed: true }
            ]
        );
        expect(plan.capture.map((file) => file.path)).toEqual(["changed.md", "new.md"]);
        expect(plan.tooLarge.map((file) => file.path)).toEqual(["huge.bin"]);
        expect(plan.removed).toEqual(["gone.md"]);
        expect(plan.restored).toEqual(["back.md"]);
    });
});

describe("how an artifact is typed and drawn", () => {
    const text = new TextEncoder().encode("hello");
    const binary = new Uint8Array([1, 0, 2]);

    it("goes by extension first, then by whether the bytes are text", () => {
        expect(files.artifactMediaType("a.md", binary)).toBe("text/markdown; charset=utf-8");
        expect(files.artifactMediaType("page.HTML", text)).toBe("text/html; charset=utf-8");
        expect(files.artifactMediaType("x.svg", text)).toBe("image/svg+xml");
        expect(files.artifactMediaType("main.rs", text)).toBe("text/plain; charset=utf-8");
        expect(files.artifactMediaType("blob", binary)).toBe("application/octet-stream");
    });

    it("maps a type onto a viewer", () => {
        expect(files.artifactKind("text/markdown; charset=utf-8")).toBe("markdown");
        expect(files.artifactKind("text/html")).toBe("html");
        expect(files.artifactKind("image/svg+xml")).toBe("image");
        expect(files.artifactKind("application/json")).toBe("text");
        expect(files.artifactKind("application/pdf")).toBe("binary");
    });
});

describe("the headers an artifact is served with", () => {
    it("sandboxes every response, with no way back to this origin", () => {
        const headers = files.artifactHeaders({
            mediaType: "text/html; charset=utf-8",
            name: "page.html",
            size: 10,
            download: false,
            immutable: true
        });
        expect(headers["content-security-policy"]).toMatch(/^sandbox allow-scripts allow-popups;/);
        expect(headers["content-security-policy"]).not.toContain("allow-same-origin");
        expect(headers["content-security-policy"]).toContain("connect-src 'none'");
        expect(headers["x-content-type-options"]).toBe("nosniff");
        expect(headers["content-disposition"]).toMatch(/^inline;/);
        expect(headers["cache-control"]).toContain("immutable");
    });

    it("downloads bytes it cannot draw, and quotes the name safely", () => {
        const headers = files.artifactHeaders({
            mediaType: "application/octet-stream",
            name: 'a"bé.bin',
            size: 3,
            download: false,
            immutable: false
        });
        expect(headers["content-disposition"]).toBe(
            `attachment; filename="a_b_.bin"; filename*=UTF-8''${encodeURIComponent('a"bé.bin')}`
        );
        expect(headers["cache-control"]).toBe("private, no-cache");
    });
});

describe("which deliverables are listed", () => {
    const fact = (path: string, kind = "text") => ({ path, name: path.split("/").at(-1) ?? path, kind, size: 1, updatedAt: "2026-11-17T00:00:00.000Z" });

    it("lists the root of the folder when there is one, and folds a bundle into one entry", () => {
        expect(deliverableArtifacts([fact("report.md"), fact("assets/a.png")]).map((entry) => entry.path)).toEqual([
            "report.md"
        ]);
        const bundled = deliverableArtifacts([fact("App.app/index.html", "html"), fact("App.app/logo.png")]);
        expect(bundled).toHaveLength(1);
        expect(bundled[0]?.bundle).toEqual({ path: "App.app", fileCount: 2 });
        expect(bundled[0]?.path).toBe("App.app/index.html");
    });
});

describe("what the agent is told", () => {
    it("names the folder and travels in the preview's argument without quoting of its own", () => {
        expect(DELIVERABLES_PROMPT).toContain(files.DELIVERABLES_DIR);
        expect(DELIVERABLES_PROMPT).not.toMatch(/["`\\$]/);
        expect(PREVIEW_PROMPT.startsWith(DELIVERABLES_PROMPT)).toBe(true);
    });
});
