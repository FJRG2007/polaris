// @vitest-environment jsdom
/**
 * A /k link that needs an account offers a sign-in that comes back to it, and
 * one that is not for this account offers to sign in another.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/k/abc" }));

const { MessagesWrapper } = await import("../setup/i18n");
const { LinkUnavailable } = await import("@/components/public-shell");

afterEach(cleanup);

describe("LinkUnavailable sign-in", () => {
    it("signs in and returns to the same link", () => {
        render(<LinkUnavailable message="Sign in" signIn={{ back: "/k/abc" }} />, {
            wrapper: MessagesWrapper
        });
        const button = screen.getByRole("link", { name: "Sign in" });
        expect(button.getAttribute("href")).toBe(
            `/oauth/login?redirect=${encodeURIComponent("/k/abc")}`
        );
    });

    it("offers another account when this one is not let in", () => {
        render(<LinkUnavailable message="Denied" signIn={{ back: "/k/abc", another: true }} />, {
            wrapper: MessagesWrapper
        });
        const button = screen.getByRole("link", { name: "Use another account" });
        expect(button.getAttribute("href")).toBe(
            `/oauth/login?redirect=${encodeURIComponent("/k/abc")}&add=1`
        );
    });

    it("offers nothing when no sign-in would help", () => {
        render(<LinkUnavailable message="Gone" />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link")).toBeNull();
    });
});
