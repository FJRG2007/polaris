// @vitest-environment jsdom

/**
 * A link to a profile, drawn on a page outside the application.
 *
 * Inside Polaris the client router carries `/u/...` and `/o/...` into the
 * application's layout so a call survives the click. That layout turns away a
 * reader with no session, so on the public pages the same link has to be a whole
 * page load - a plain anchor the router never sees.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OutsideApp, ProfileLink } from "@/components/profile-link";

vi.mock("next/link", () => ({
    default: ({ children, ...props }: { children: React.ReactNode }) => (
        <a data-router="" {...props}>
            {children}
        </a>
    )
}));

afterEach(cleanup);

describe("a profile link", () => {
    it("goes through the router inside the application", () => {
        render(<ProfileLink href="/u/sam">Sam</ProfileLink>);
        expect(screen.getByText("Sam").hasAttribute("data-router")).toBe(true);
    });

    it("is a plain anchor on a page outside it", () => {
        render(
            <OutsideApp>
                <ProfileLink href="/o/acme" className="row">
                    Acme
                </ProfileLink>
            </OutsideApp>
        );
        const link = screen.getByText("Acme");
        expect(link.hasAttribute("data-router")).toBe(false);
        expect(link.getAttribute("href")).toBe("/o/acme");
        expect(link.className).toBe("row");
    });
});
