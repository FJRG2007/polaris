// @vitest-environment jsdom

/**
 * The connection banner: said the moment the device goes offline, "back online"
 * only after a real drop and only for a moment, and a slow line named only in a
 * call. And, told apart from all of that, Polaris itself not answering while the
 * device is online - an update rolling over says so as an update - and Polaris
 * coming back, unless it came back on a new build, which the new-build card says.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";

let state = { online: true, recovered: false, slow: false };
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => state }));
let newBuild = false;
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => newBuild }));

const { ConnectionBanner, SlowConnectionNotice } = await import("@/components/connection-banner");
const { noteStreamTrouble, probeNow, resetReachability } = await import("@/lib/reachability");
const { clearUpdateInProgress, markUpdateInProgress } = await import("@/lib/update-in-progress");

/** Whether the probe finds Polaris answering. */
let answering = true;
const fetchMock = vi.fn(async () =>
    answering
        ? new Response(JSON.stringify({ build: "b1" }), { headers: { "content-type": "application/json" } })
        : Promise.reject(new TypeError("Failed to fetch"))
);

beforeEach(() => {
    state = { online: true, recovered: false, slow: false };
    newBuild = false;
    answering = true;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom here has no storage of its own; the mark lives in it.
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key)
    });
    resetReachability();
    clearUpdateInProgress();
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Something the app was doing failed, and the probe it starts has answered. */
async function streamDrops(): Promise<void> {
    await act(async () => {
        noteStreamTrouble();
        await probeNow();
    });
}

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

describe("when Polaris itself does not answer", () => {
    it("asks nothing while everything works", () => {
        render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        act(() => {
            vi.advanceTimersByTime(10 * 60 * 1000);
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says Polaris cannot be reached, apart from being offline", async () => {
        answering = false;
        render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        await streamDrops();
        const status = screen.getByRole("status").textContent ?? "";
        expect(status).toContain("Can't reach Polaris");
        expect(status).not.toContain("offline");
        expect(screen.getByRole("button", { name: "Try now" })).toBeTruthy();
    });

    it("says only that the device is offline when it is, without asking Polaris", async () => {
        answering = false;
        state = { online: false, recovered: false, slow: false };
        render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        await streamDrops();
        expect(screen.getByRole("status").textContent).toContain("You're offline");
    });

    it("says an update is rolling over rather than that something broke", async () => {
        answering = false;
        markUpdateInProgress();
        render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        await streamDrops();
        expect(screen.getByRole("status").textContent).toContain("Polaris is updating");
    });

    it("says Polaris is back once it answers again, then goes away by itself", async () => {
        answering = false;
        const { container } = render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        await streamDrops();
        answering = true;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByRole("status").textContent).toContain("Polaris is back");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4000);
        });
        expect(container.textContent).toBe("");
    });

    it("leaves a return on a new build to the new-build card", async () => {
        answering = false;
        const { container } = render(<ConnectionBanner />, { wrapper: MessagesWrapper });
        await streamDrops();
        answering = true;
        newBuild = true;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(container.textContent).toBe("");
    });

    it("reads in Spanish", async () => {
        answering = false;
        const { unmount } = render(withMessages(<ConnectionBanner />, "es-ES"));
        await streamDrops();
        expect(screen.getByRole("status").textContent).toContain("No se puede contactar con Polaris");
        expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
        unmount();
        markUpdateInProgress();
        render(withMessages(<ConnectionBanner />, "es-ES"));
        expect(screen.getByRole("status").textContent).toContain("Polaris se está actualizando");
        answering = true;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByRole("status").textContent).toContain("Polaris ha vuelto");
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
