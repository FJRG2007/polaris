// @vitest-environment jsdom

/**
 * A load that stops never stays on its loading screen for good. A WebGPU that
 * answers neither yes nor no left the city on "Building the city" forever: the
 * game falls back to WebGL 2 after a few seconds, and the frame around it says
 * the game could not start once its page has gone quiet mid-load.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GameFrame, STALLED_MS } from "../../../arcade/src/screens/game-frame";
import {
    WEBGPU_START_MS,
    startRenderer
} from "../../../arcade/game/new-york/engine/graphics-start.js";
import type { GameDefinition } from "../../../arcade/src/games/types";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" } }
}));
vi.mock("../../../arcade/src/screens/i18n", () => ({ useArcadeT: () => (key: string) => key }));

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

type Fake = {
    init: () => Promise<void>;
    backend: { isWebGPUBackend: boolean };
    domElement: { remove: () => void };
};

function fake(init: () => Promise<void>, webgpu: boolean): Fake {
    return { init, backend: { isWebGPUBackend: webgpu }, domElement: { remove: vi.fn() } };
}

describe("starting the graphics", () => {
    it("starts again on WebGL 2 when WebGPU never answers", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const hung = fake(() => new Promise(() => {}), true);
        const webgl = fake(() => Promise.resolve(), false);
        const create = vi.fn((forceWebGL: boolean) => (forceWebGL ? webgl : hung));
        const started = startRenderer(create);
        await vi.advanceTimersByTimeAsync(WEBGPU_START_MS);
        await expect(started).resolves.toBe(webgl);
        expect(create.mock.calls).toEqual([[false], [true]]);
        expect(hung.domElement.remove).toHaveBeenCalled();
    });

    it("keeps a WebGPU that starts", async () => {
        const webgpu = fake(() => Promise.resolve(), true);
        const create = vi.fn(() => webgpu);
        await expect(startRenderer(create)).resolves.toBe(webgpu);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("fails when WebGL 2, the last thing to try, fails", async () => {
        const broken = fake(() => Promise.reject(new Error("no WebGL")), false);
        const create = vi.fn(() => broken);
        await expect(startRenderer(create)).rejects.toThrow("no WebGL");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("fails when neither starts in time", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const create = vi.fn((forceWebGL: boolean) =>
            fake(() => new Promise(() => {}), !forceWebGL)
        );
        const started = startRenderer(create, { webgpuMs: 10, webglMs: 10 });
        const outcome = expect(started).rejects.toThrow("did not start");
        await vi.advanceTimersByTimeAsync(20);
        await outcome;
    });
});

describe("the game's frame, mid-load", () => {
    const game = { id: "new-york" } as unknown as GameDefinition;

    async function tell(data: unknown) {
        const frame = document.querySelector("iframe")!;
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent("message", { data, origin: "null", source: frame.contentWindow })
            );
        });
    }

    it("says the game could not start once its page goes quiet", async () => {
        vi.useFakeTimers();
        render(<GameFrame game={game} />);
        await tell({ type: "polaris-game:hello" });
        await tell({ type: "polaris-game:progress", stage: "data", done: 1 });
        await act(async () => vi.advanceTimersByTime(STALLED_MS - 1));
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => vi.advanceTimersByTime(1));
        expect(screen.getByRole("alert").textContent).toContain("failed");
    });

    it("waits as long as progress keeps coming, and not at all once the city is up", async () => {
        vi.useFakeTimers();
        render(<GameFrame game={game} />);
        await tell({ type: "polaris-game:progress", stage: "build", done: 0.5 });
        await act(async () => vi.advanceTimersByTime(STALLED_MS - 1));
        await tell({ type: "polaris-game:progress", stage: "compile", done: 0.5 });
        await act(async () => vi.advanceTimersByTime(STALLED_MS - 1));
        await tell({ type: "polaris-game:ready" });
        await act(async () => vi.advanceTimersByTime(STALLED_MS * 2));
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
