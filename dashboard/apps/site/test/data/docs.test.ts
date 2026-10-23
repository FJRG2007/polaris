import { describe, expect, it } from "vitest";
import {
    docSlug,
    exampleFromSchema,
    headingId,
    requestSamples,
    rewriteDocLinks,
    splitDoc
} from "../../src/data/docs";

const slugs = new Set(["chat", "calls"]);
const rewrite = (html: string) =>
    rewriteDocLinks(html, { slugs, repo: "owner/polaris", dir: "docs/features" });

describe("the feature guides", () => {
    it("names a page after its file, in either language", () => {
        expect(docSlug("game-servers.md")).toBe("game-servers");
        expect(docSlug("game-servers.es.md")).toBe("game-servers");
    });

    it("drops the guide's own title and the line linking the other language", () => {
        for (const readme of ["../../README.md", "../../README.es.md"]) {
            const { title, body } = splitDoc(
                `# Chat\n\n[Leer en español](chat.es.md) - [Back](${readme})\n\nFirst paragraph.\n`
            );
            expect(title).toBe("Chat");
            expect(body).toBe("First paragraph.");
        }
    });

    it("anchors a heading without accents or punctuation", () => {
        expect(headingId("Archivos, grabaciones y reenvío")).toBe("archivos-grabaciones-y-reenvio");
    });

    it("points another guide at its page and a picture at the site's media", () => {
        const { html, media } = rewrite(
            '<a href="calls.md#rooms">x</a><source srcset="../assets/media/a-light.webp"><img src="../assets/media/a-dark.webp">'
        );
        expect(html).toContain('href="../calls/#rooms"');
        expect(html).toContain('srcset="../../../media/a-light.webp"');
        expect(html).toContain('src="../../../media/a-dark.webp"');
        expect(media.sort()).toEqual(["a-dark.webp", "a-light.webp"]);
    });

    it("opens anything else in the repository on GitHub, and leaves outside links alone", () => {
        const { html } = rewrite(
            '<a href="../../README.md">r</a><a href="https://example.com">e</a><a href="#here">h</a>'
        );
        expect(html).toContain('href="https://github.com/owner/polaris/blob/main/README.md"');
        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('href="#here"');
    });
});

describe("the API examples", () => {
    it("fills a body from its schema", () => {
        expect(
            exampleFromSchema({
                type: "object",
                properties: {
                    port: { type: "integer", minimum: 1 },
                    mode: { type: "string", enum: ["le", "custom"] },
                    tags: { type: "array", items: { type: "string" } },
                    on: { type: "boolean" }
                }
            })
        ).toEqual({ port: 1, mode: "le", tags: ["string"], on: false });
    });

    it("shows the same call in curl, JavaScript and Python, with the key from the environment", () => {
        const samples = requestSamples(
            {
                method: "POST",
                path: "/api/v1/things",
                body: JSON.stringify({ type: "object", properties: { on: { type: "boolean" } } })
            },
            "https://polaris.example.com"
        );
        expect(samples.map((sample) => sample.label)).toEqual(["curl", "JavaScript", "Python"]);
        for (const sample of samples) {
            expect(sample.code).toContain("https://polaris.example.com/api/v1/things");
            expect(sample.code).toContain("POLARIS_API_KEY");
        }
        expect(samples[0]!.code).toContain("-d '{");
        expect(samples[2]!.code).toContain('"on": False');
    });

    it("sends no body when the operation takes none", () => {
        const [curl] = requestSamples(
            { method: "GET", path: "/api/v1/me", body: null },
            "https://x.test"
        );
        expect(curl!.code).not.toContain("-d ");
        expect(curl!.code).not.toContain("Content-Type");
    });
});
