// @vitest-environment jsdom

/**
 * Polaris login's state is not asked for again the moment the page opens.
 *
 * The page already read it on the server and handed it over; asking once more on
 * mount was the same answer a moment later, and on the Minecraft tabs that call
 * headed the queue every other action waits in. It is still read on its interval,
 * and read at once when the page had nothing to hand over.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const asked = vi.fn();

vi.mock("@polaris/app-host/client", () => ({
    hostUi: new Proxy({}, { get: () => new Proxy({}, { get: () => () => null }) })
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: async () => {
        asked();
        return { state: null, error: "not now" };
    }
}));

const { useLoginState } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-polaris-login"
);

const SERVER = "00000000-0000-4000-8000-000000000001";

function Probe({ initial, refreshMs }: { initial: unknown; refreshMs?: number }) {
    useLoginState(SERVER, initial as never, true, refreshMs);
    return null;
}

afterEach(() => {
    cleanup();
    asked.mockReset();
    vi.useRealTimers();
});

describe("useLoginState", () => {
    it("does not ask again on mount for what the page already read", async () => {
        vi.useFakeTimers();
        render(<Probe initial={{ on: true, players: [] }} refreshMs={60_000} />);
        await vi.advanceTimersByTimeAsync(0);
        expect(asked).not.toHaveBeenCalled();
        // The interval still runs.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(asked).toHaveBeenCalledTimes(1);
    });

    it("asks at once when the page had nothing to hand over", async () => {
        render(<Probe initial={null} />);
        await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    });
});
