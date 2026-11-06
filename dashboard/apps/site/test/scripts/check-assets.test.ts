import { describe, expect, it } from "vitest";
import { pictureRefs, refProblem } from "../../scripts/check-assets.mjs";

const written = new Set(["logos/apps/n8n.svg", "media/home.webp", "en/media/local.png"]);
const options = (page = "en/marketplace/index.html") => ({
    page,
    base: "/polaris",
    origin: "https://fjrg2007.github.io",
    exists: (file: string) => written.has(file)
});

describe("the export's picture check", () => {
    it("finds pictures in src, srcset, meta content and inline url()", () => {
        const html = `<img src="/polaris/logos/apps/n8n.svg"><source srcSet="/a.webp 1x, /b.webp 2x">
            <meta content="https://fjrg2007.github.io/polaris/media/home.webp">
            <span style="background-image:url(&quot;/c.png&quot;)"></span><a href="/polaris/en/">x</a>`;
        expect(pictureRefs(html)).toEqual([
            "/polaris/logos/apps/n8n.svg",
            "/a.webp",
            "/b.webp",
            "https://fjrg2007.github.io/polaris/media/home.webp",
            "/c.png"
        ]);
    });

    it("passes a picture under the base path that the build wrote", () => {
        expect(refProblem("/polaris/logos/apps/n8n.svg", options())).toBeNull();
        expect(
            refProblem("https://fjrg2007.github.io/polaris/media/home.webp", options())
        ).toBeNull();
        expect(refProblem("../../en/media/local.png", options())).toBeNull();
        expect(refProblem("data:image/svg+xml,<svg/>", options())).toBeNull();
    });

    it("matches the site's own origin however the owner is cased", () => {
        // CI writes the origin from the repository owner as it is spelled.
        const cased = { ...options(), origin: "https://FJRG2007.github.io" };
        expect(refProblem("https://fjrg2007.github.io/polaris/media/home.webp", cased)).toBeNull();
        expect(refProblem("https://example.com/polaris/media/home.webp", cased)).toMatch(
            /hotlinked/
        );
    });

    it("fails a path from the domain's root, which Pages serves outside the site", () => {
        expect(refProblem("/logos/apps/n8n.svg", options())).toMatch(/outside the base path/);
    });

    it("fails a picture the build never wrote", () => {
        expect(refProblem("/polaris/logos/apps/missing.svg", options())).toMatch(/did not write/);
    });

    it("fails a picture hotlinked from another site", () => {
        expect(refProblem("https://cdn.example.com/logo.svg", options())).toMatch(/hotlinked/);
    });

    it("checks against the root when the site has its own domain", () => {
        const own = { ...options(), base: "" };
        expect(refProblem("/logos/apps/n8n.svg", own)).toBeNull();
    });
});
