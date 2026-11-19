// @vitest-environment jsdom

/**
 * How a finished sign-in moves on. In the phone app's own window it is a whole
 * page load - the router's move left that window blank until the app was
 * reopened - and in a browser it stays the router's.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { landAfterSignIn } from "@/app/oauth/login/post-login-target";

const router = () => ({ push: vi.fn(), refresh: vi.fn() });

afterEach(() => {
    delete (window as { polarisMobile?: unknown }).polarisMobile;
    vi.restoreAllMocks();
});

describe("landing after a sign-in", () => {
    it("uses the router in a browser", () => {
        const moved = router();
        landAfterSignIn(moved, "/chat");
        expect(moved.push).toHaveBeenCalledWith("/chat");
        expect(moved.refresh).toHaveBeenCalled();
    });

    it("loads the page whole inside the phone app", () => {
        const assign = vi.fn();
        const location = window.location;
        Object.defineProperty(window, "location", {
            configurable: true,
            value: { ...location, assign, search: "" }
        });
        try {
            (window as { polarisMobile?: unknown }).polarisMobile = { platform: () => "android" };
            const moved = router();
            landAfterSignIn(moved, "/chat");
            expect(assign).toHaveBeenCalledWith("/chat");
            expect(moved.push).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(window, "location", { configurable: true, value: location });
        }
    });
});
