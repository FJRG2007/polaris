// @vitest-environment jsdom

/**
 * The connection banner: said the moment the device goes offline, "back online"
 * only after a real drop and only for a moment, and a slow line named only in a
 * call.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";

let state = { online: true, recovered: false, slow: false };
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => state }));

const { ConnectionBanner, SlowConnectionNotice } = await import("@/components/connection-banner");

beforeEach(() => {
    state = { online: true, recovered: false, slow: false };
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the connection banner", () => {
    it("says nothing on a page that opened online", () => {
        const { container } = render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        expect(container.textContent).toBe("");
    });

    it("says so the moment the device is offline", () => {
        state = { online: false, recovered: false, slow: false };
        render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("status").textContent).toContain("You're offline");
    });

    it("says back online after a drop, then goes away by itself", () => {
        state = { online: true, recovered: true, slow: false };
        const { container } = render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Back online")).toBeTruthy();
        act(() => {
            vi.advanceTimersByTime(4000);
        });
        expect(container.textContent).toBe("");
    });

    it("reads in Spanish", () => {
        state = { online: false, recovered: false, slow: false };
        render(withMessages(<ConnectionBanner />, "es-ES"));
        expect(screen.getByRole("status").textContent).toContain("Sin conexión");
    });
});

describe("a slow line in a call", () => {
    it("is named when the connection is slow", () => {
        state = { online: true, recovered: false, slow: true };
        render(<SlowConnectionNotice />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("status").textContent).toContain("Your connection is slow");
    });

    it("is not named when it is fine, or when there is none at all", () => {
        const { container, rerender } = render(<SlowConnectionNotice />, { wrapper: MessagesWrapper });
        expect(container.textContent).toBe("");
        state = { online: false, recovered: false, slow: true };
        rerender(<SlowConnectionNotice />);
        expect(container.textContent).toBe("");
    });
});
