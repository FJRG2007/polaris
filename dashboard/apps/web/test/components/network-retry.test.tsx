// @vitest-environment jsdom
/**
 * A page that failed on a network blip gets itself back.
 *
 * The desktop app opens with the computer, often before the network settled, and
 * the first request of a page fails with `TypeError: Failed to fetch`. The
 * boundary retries that by itself with the page's skeleton up, and shows a card
 * - about the connection, never the raw "network error" - only once the retries
 * ran out. Any other failure keeps the card it always had.
 */

import { MessagesWrapper } from "../setup/i18n";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/route-skeleton", () => ({ RouteSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => {} }));

const { default: AppError } = await import("../../src/app/(app)/error");
const retry = await import("../../src/lib/network-retry");

function networkFailure(): Error {
    return new TypeError("Failed to fetch");
}

/** A boundary that throws again on every retry until `recoverAfter` retries. */
function Harness({ recoverAfter }: { recoverAfter: number }) {
    const [state, setState] = useState<{ error: Error | null; retries: number }>({ error: networkFailure(), retries: 0 });
    if (state.retries >= recoverAfter && state.error === null) return <p>the page</p>;
    return (
        <AppError
            key={state.retries}
            error={state.error as Error}
            reset={() =>
                setState((previous) => {
                    const retries = previous.retries + 1;
                    return { retries, error: retries >= recoverAfter ? null : networkFailure() };
                })
            }
        />
    );
}

function show(node: ReactNode) {
    render(<MessagesWrapper>{node}</MessagesWrapper>);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    retry.resetNetworkStreak();
    refresh.mockClear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("recognising a network failure", () => {
    it("knows each browser's wording, and anything while the browser is offline", () => {
        for (const message of ["Failed to fetch", "network error", "Load failed", "NetworkError when attempting to fetch resource."]) {
            expect(retry.isNetworkError(new TypeError(message), true)).toBe(true);
        }
        expect(retry.isNetworkError(new Error("Cannot read properties of undefined"), false)).toBe(true);
    });

    it("leaves a fault in the page alone", () => {
        expect(retry.isNetworkError(new Error("Cannot read properties of undefined (reading 'id')"), true)).toBe(false);
        expect(retry.isNetworkError(new Error("network error in the chat reducer, state 4"), true)).toBe(false);
    });
});

describe("the dashboard boundary on a network failure", () => {
    it("retries by itself with the skeleton up, and the page comes back without a card", async () => {
        show(<Harness recoverAfter={2} />);

        expect(screen.getByTestId("skeleton")).toBeTruthy();
        expect(screen.queryByText("Try again")).toBeNull();
        await advance(500);
        expect(screen.getByTestId("skeleton")).toBeTruthy();
        await advance(1500);

        expect(screen.getByText("the page")).toBeTruthy();
        expect(screen.queryByText(/network error/i)).toBeNull();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("shows the connection card only after every retry failed, and never the raw error", async () => {
        show(<Harness recoverAfter={99} />);

        await advance(500);
        await advance(1500);
        expect(screen.getByTestId("skeleton")).toBeTruthy();
        await advance(4000);

        expect(screen.getByText("Can't reach Polaris right now")).toBeTruthy();
        expect(screen.getByText("It'll retry as soon as the connection is back.")).toBeTruthy();
        expect(screen.getByText("Try again")).toBeTruthy();
        expect(screen.queryByText(/failed to fetch/i)).toBeNull();
        expect(screen.queryByText("Polaris could not start this page")).toBeNull();
    });

    it("retries again when the connection comes back", async () => {
        show(<Harness recoverAfter={4} />);
        await advance(500);
        await advance(1500);
        await advance(4000);
        expect(screen.getByText("Can't reach Polaris right now")).toBeTruthy();

        await act(async () => {
            window.dispatchEvent(new Event("online"));
        });

        expect(screen.getByText("the page")).toBeTruthy();
    });

    it("lets the reader retry from the card", async () => {
        show(<Harness recoverAfter={4} />);
        await advance(6000);
        await advance(6000);
        await advance(6000);

        await act(async () => {
            fireEvent.click(screen.getByText("Try again"));
        });

        expect(screen.getByText("the page")).toBeTruthy();
    });
});

describe("the dashboard boundary on any other failure", () => {
    it("keeps the card that names what was thrown, with no retry scheduled", async () => {
        const reset = vi.fn();
        show(<AppError error={new Error("Cannot read properties of undefined (reading 'id')")} reset={reset} />);

        expect(screen.queryByTestId("skeleton")).toBeNull();
        expect(screen.getByText("This page stopped working")).toBeTruthy();
        expect(screen.getByText(/Cannot read properties of undefined/)).toBeTruthy();
        await advance(10_000);
        expect(reset).not.toHaveBeenCalled();
    });
});
