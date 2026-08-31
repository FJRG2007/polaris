// @vitest-environment jsdom

/**
 * What an address with nothing behind it now says.
 *
 * There were two failures here and the second is the one that hurt. The first
 * was cosmetic: an unmatched URL got the framework's own page, which looks
 * nothing like Polaris and offers no way back. The second is that it told you
 * nothing you could act on - a broken link of ours reads exactly like a link you
 * mistyped, and the only person who can tell them apart is the one holding the
 * address, in the one place nobody thinks to look.
 *
 * So the path is on the page. That is the whole of the bug report for the case
 * that produced this page: a tab in the deploy rail that had pointed at
 * /apps/deploy/<id>/admin/settings since it was written.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const pathname = vi.fn(() => "/apps/deploy/019fc9e3/admin/settings");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

const { default: NotFound } = await import("@/app/not-found");
const { default: AppNotFound } = await import("@/app/(app)/not-found");

afterEach(cleanup);

describe("an address that matches nothing", () => {
    it("says so in the product's own words rather than the framework's", () => {
        render(<NotFound />);
        expect(screen.getByRole("heading").textContent).toContain("nothing at this address");
    });

    it("shows the address, which is the whole of the bug report when the link was ours", () => {
        render(<NotFound />);
        expect(screen.getByText("/apps/deploy/019fc9e3/admin/settings")).toBeTruthy();
    });

    it("offers a way out, since a dead end with no exit is the actual complaint", () => {
        render(<NotFound />);
        const overview = screen.getByRole("link", { name: /overview/i });
        expect(overview.getAttribute("href")).toBe("/home");
        expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
    });

    it("does not fall over before the path is known", () => {
        // usePathname is null for a moment on some transitions, and a 404 page
        // that throws is a 500 wearing its clothes.
        pathname.mockReturnValueOnce(null as unknown as string);
        render(<NotFound />);
        expect(screen.getByRole("heading")).toBeTruthy();
    });
});

describe("something that has gone, inside the dashboard", () => {
    it("keeps the reader where they are instead of sending them to the front door", () => {
        render(<AppNotFound />);
        expect(screen.getByText(/not here any more/i)).toBeTruthy();
        // Back first: what they wanted next is almost never the overview.
        const actions = screen.getAllByRole("button").map((node) => node.textContent ?? "");
        expect(actions[0]).toMatch(/back/i);
    });
});
