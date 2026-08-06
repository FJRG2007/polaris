/**
 * What somebody reads when they are not editing.
 *
 * The renderer never sets HTML, so these check two things that would matter if
 * it ever did: markup in the source comes out as text, and a mention comes out
 * as a chip pointing where it says it points.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/rich-text/rich-text";

const id = "0193b0f0-0000-7000-8000-000000000001";

function render(markdown: string): string {
    return renderToStaticMarkup(<RichText value={markdown} />);
}

describe("reading rich text", () => {
    it("draws the formatting", () => {
        const markup = render("## Plan\n\n- **first**\n- second");
        expect(markup).toContain("<h2>Plan</h2>");
        expect(markup).toContain("<strong>first</strong>");
        expect(markup).toContain("<ul");
    });

    it("shows a mention as a name rather than as an address", () => {
        const markup = render(`Ask [@Ana Ruiz](polaris:user/${id}).`);
        expect(markup).toContain("@Ana Ruiz");
        expect(markup).not.toContain("polaris:user");
    });

    it("links a task reference to the task", () => {
        const markup = render(`Blocked by [Fix the cert](polaris:task/${id}).`);
        expect(markup).toContain(`href="/tasks/t/${id}"`);
        expect(markup).toContain("Fix the cert");
    });

    it("sends an outside link away from Polaris and stops it reaching back", () => {
        const markup = render("[docs](https://example.com)");
        expect(markup).toContain('rel="noopener noreferrer nofollow"');
        expect(markup).toContain('target="_blank"');
    });

    it("renders markup in the source as text, never as markup", () => {
        const markup = render("Careful: <img src=x onerror=alert(1)> and <script>alert(2)</script>");
        expect(markup).not.toContain("<img");
        expect(markup).not.toContain("<script");
        expect(markup).toContain("&lt;script&gt;");
    });

    it("shows nothing at all for nothing at all", () => {
        expect(render("")).toBe("");
        expect(render("   ")).toBe("");
    });
});
