// @vitest-environment jsdom

/**
 * The connectors screen learns a sign-in finished without being reloaded:
 * the provider's page may open where this page cannot see it (the desktop
 * app of an older release hands it to the system browser), so the list is
 * read again from the server while one waits and when the window is back.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolarConnectors } from "@/app/(app)/polar/settings/polar-connectors";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
    default: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    )
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const STRIPE = {
    id: "0190a000-0000-7000-8000-000000000009",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    auth: "oauth",
    transport: "http",
    enabled: true,
    signedIn: false,
    status: "new",
    lastError: null,
    tools: []
};
const SIGNED_IN = { ...STRIPE, signedIn: true, status: "ok" };

function serverSays(...answers: unknown[]) {
    const fetch = vi.fn(async () => {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        return new Response(JSON.stringify({ connectors: [next] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

/** Draws the screen with Stripe's detail open, where its sign-in lives. */
function draw() {
    const drawn = render(<PolarConnectors initial={[STRIPE as never]} returned={null} />, {
        wrapper: MessagesWrapper
    });
    fireEvent.click(screen.getByRole("button", { name: /^Stripe/ }));
    return drawn;
}

describe("a sign-in that finished elsewhere", () => {
    it("shows as connected once the window is back, without a reload", async () => {
        const fetch = serverSays(SIGNED_IN);
        draw();
        expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
        fireEvent.focus(window);
        await waitFor(() =>
            expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull()
        );
        expect(fetch).toHaveBeenCalledWith("/api/polar/connectors", expect.anything());
    });

    it("is checked on while it waits, and says so once the server has it", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // jsdom cannot navigate: the page stays, as it does when the
        // provider's page opened in another window.
        const fetch = serverSays(STRIPE, SIGNED_IN);
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(screen.getByText(/Finish signing in on the page that opened/)).toBeTruthy();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
        });
        await waitFor(() =>
            expect(screen.getByText("Signed in. Polar can use this connector now.")).toBeTruthy()
        );
        const calls = fetch.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(9_000);
        });
        // Done waiting: no more checks.
        expect(fetch.mock.calls.length).toBe(calls);
    });

    it("stops checking after a while when it never finishes", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fetch = serverSays(STRIPE);
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(125_000);
        });
        const calls = fetch.mock.calls.length;
        expect(calls).toBeLessThanOrEqual(41);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(fetch.mock.calls.length).toBe(calls);
        expect(screen.queryByText(/Finish signing in/)).toBeNull();
        expect(
            (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled
        ).toBe(false);
    });
});
