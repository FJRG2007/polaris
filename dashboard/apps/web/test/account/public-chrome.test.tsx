/**
 * The bar a reader with no account gets.
 *
 * Two things are asserted and they are both about honesty. It offers a way in,
 * because a page with no way into the product it belongs to is a dead end; and
 * the second button is the invitation screen rather than a sign-up, because
 * accounts here come from an invitation and nothing else - a "Create account"
 * button would lead to a form that cannot exist.
 *
 * The About/Privacy/Terms row is asserted too. Those pages are what an outside
 * reviewer is sent to, and a public page of ours that does not link them is a
 * page that fails a verification months later for a reason nobody connects to
 * this file.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The paths are constants, but the module they live in resolves the deployment's
// own address and reads settings to do it.
vi.mock("@/lib/legal/service", () => ({
    PUBLIC_PATHS: { home: "/about", privacy: "/legal/privacy", terms: "/legal/terms" }
}));

const { PublicChrome } = await import("@/components/public-chrome");

const html = renderToStaticMarkup(
    <PublicChrome>
        <p>a profile</p>
    </PublicChrome>
);

describe("the public bar", () => {
    it("offers the way in", () => {
        expect(html).toContain('href="/oauth/login"');
        expect(html).toContain("Sign in");
    });

    it("offers the invitation screen rather than a sign-up that cannot exist", () => {
        expect(html).toContain('href="/oauth/accept-invite"');
        expect(html).not.toMatch(/sign ?up|create an account/i);
    });

    it("links the pages a reviewer is sent to", () => {
        for (const path of ["/about", "/legal/privacy", "/legal/terms"]) {
            expect(html).toContain(`href="${path}"`);
        }
    });

    it("draws what it was handed", () => {
        expect(html).toContain("a profile");
    });
});
