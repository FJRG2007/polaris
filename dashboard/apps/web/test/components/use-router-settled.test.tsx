// @vitest-environment jsdom

/**
 * The frame waits for the router before reaching it on its own.
 *
 * A router action dispatched while a page's streamed redirect is being carried
 * out crashes the tab (React #310 in Next's App Router). Measured against a
 * production build: `router.refresh()` 5-20 ms after hydration of a page that
 * redirects crashed it every time; from 40 ms on, once the redirect had landed,
 * it never did. These pin when the frame is allowed to act.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/tasks/l/gone";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { routerSettled, STREAMED_REDIRECT_MARKER, useRouterSettled } = await import(
    "@/components/use-router-settled"
);

function streamRedirect(): void {
    const meta = document.createElement("meta");
    meta.id = STREAMED_REDIRECT_MARKER;
    document.head.append(meta);
}

beforeEach(() => {
    pathname = "/tasks/l/gone";
});

afterEach(() => {
    cleanup();
    document.getElementById(STREAMED_REDIRECT_MARKER)?.remove();
});

describe("routerSettled", () => {
    it("is settled when no redirect was streamed", () => {
        expect(routerSettled(false, "/home", "/home")).toBe(true);
    });

    it("waits while a streamed redirect has not moved the router yet", () => {
        expect(routerSettled(true, "/tasks/l/gone", "/tasks/l/gone")).toBe(false);
    });

    it("is settled once the redirect has landed somewhere else", () => {
        expect(routerSettled(true, "/tasks/l/gone", "/tasks")).toBe(true);
    });
});

describe("useRouterSettled", () => {
    it("is settled straight away on a document that did not redirect", () => {
        const { result } = renderHook(() => useRouterSettled());
        expect(result.current).toBe(true);
    });

    it("holds the frame back until the streamed redirect lands, then stays settled", () => {
        streamRedirect();
        const { result, rerender } = renderHook(() => useRouterSettled());
        expect(result.current).toBe(false);

        pathname = "/tasks";
        rerender();
        expect(result.current).toBe(true);

        // Later navigations are ordinary ones, even back to where it started.
        pathname = "/tasks/l/gone";
        rerender();
        expect(result.current).toBe(true);
    });

    it("does not decide while the document is still streaming", () => {
        const state = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
        const { result } = renderHook(() => useRouterSettled());
        expect(result.current).toBe(false);

        state.mockReturnValue("interactive");
        act(() => {
            document.dispatchEvent(new Event("DOMContentLoaded"));
        });
        expect(result.current).toBe(true);
        state.mockRestore();
    });
});
