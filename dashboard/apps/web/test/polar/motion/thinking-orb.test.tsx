// @vitest-environment jsdom
/**
 * The thinking orb says what Polar is doing from the stream it already has,
 * names that in words for a screen reader, draws one still frame for someone
 * who asked for less motion, and never leaves a loop running once it is gone.
 */

import { stubCanvas } from "./canvas-stub";
import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { MODE_FRAMES } from "@/components/polar/motion/orb-engine/registry";
import { orbForActivity, orbForTool } from "@/components/polar/motion/orb-activity";
import { ORB_STATES, resolvePreset } from "@/components/polar/motion/orb-engine/presets";

const tool = (name: string, state = "input-available") => ({ type: `tool-${name}`, state });

describe("which orb shows", () => {
    it("breathes while it waits for the first word", () => {
        expect(orbForActivity({ status: "submitted", parts: [] })).toBe("breathing");
        expect(orbForActivity({ status: "streaming", parts: [] })).toBe("breathing");
    });

    it("solves while the model thinks and composes while it writes", () => {
        const reasoning = { type: "reasoning", text: "hm" };
        const text = { type: "text", text: "Here" };
        expect(orbForActivity({ status: "streaming", parts: [reasoning] })).toBe("solving");
        expect(orbForActivity({ status: "streaming", parts: [reasoning, text] })).toBe("composing");
    });

    it("names one running tool by what it does", () => {
        expect(orbForTool(tool("polaris_search"))).toBe("searching");
        expect(orbForTool(tool("databases_query"))).toBe("searching");
        expect(orbForTool(tool("drive_list"))).toBe("shaping");
        expect(orbForTool({ type: "dynamic-tool", toolName: "anything" })).toBe("connecting");
        expect(orbForTool(tool("github__create_issue"))).toBe("connecting");
        expect(orbForTool(tool("deploy_restart"))).toBe("working");
        expect(orbForTool(tool("deploy_webhooks"))).toBe("working");
        expect(orbForActivity({ status: "streaming", parts: [tool("drive_stat")] })).toBe(
            "shaping"
        );
    });

    it("weaves when more than one tool runs at once, and ignores finished ones", () => {
        const two = [tool("polaris_search"), tool("drive_list", "input-streaming")];
        expect(orbForActivity({ status: "streaming", parts: two })).toBe("weaving");
        const oneDone = [tool("polaris_search", "output-available"), tool("drive_list")];
        expect(orbForActivity({ status: "streaming", parts: oneDone })).toBe("shaping");
    });

    it("listens to the microphone and connects while the stream comes back", () => {
        expect(orbForActivity({ status: "ready", parts: [], listening: true })).toBe("listening");
        expect(orbForActivity({ status: "error", parts: [], reconnecting: true })).toBe(
            "connecting"
        );
    });

    it("shows nothing once the turn is over", () => {
        expect(orbForActivity({ status: "ready", parts: [tool("x", "output-available")] })).toBe(
            null
        );
        expect(orbForActivity({ status: "error", parts: [] })).toBe(null);
    });
});

describe("the geometry", () => {
    it("draws every state at both tuned sizes, inside the canvas", () => {
        for (const state of ORB_STATES) {
            for (const size of [64, 20] as const) {
                const { mode, opts } = resolvePreset(state, size);
                const frame = MODE_FRAMES[mode](size, 1.3, opts);
                expect(frame.dots.length).toBeGreaterThan(0);
                for (const dot of frame.dots) {
                    expect(Number.isFinite(dot.x) && Number.isFinite(dot.y)).toBe(true);
                    expect(dot.x).toBeGreaterThan(-2);
                    expect(dot.x).toBeLessThan(size + 2);
                }
            }
        }
    });
});

function motion(reduced: boolean) {
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: reduced && query.includes("reduce"),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }))
    );
}

describe("the orb", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is an image named for its state", () => {
        motion(false);
        render(withMessages(<ThinkingOrb state="searching" size={20} />));
        expect(screen.getByRole("img", { name: "Searching" })).toBeTruthy();
    });

    it("stays silent when the text beside it already names the state", () => {
        motion(false);
        const view = render(withMessages(<ThinkingOrb state="searching" decorative />));
        expect(screen.queryByRole("img")).toBeNull();
        expect(view.container.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
    });

    it("speaks Spanish too", () => {
        motion(false);
        render(withMessages(<ThinkingOrb state="composing" />, "es-ES"));
        expect(screen.getByRole("img", { name: "Escribiendo" })).toBeTruthy();
    });

    it("draws one still frame and starts no loop under reduced motion", () => {
        motion(true);
        const canvas = stubCanvas();
        const raf = vi.spyOn(window, "requestAnimationFrame");
        render(withMessages(<ThinkingOrb state="weaving" />));
        expect(screen.getByRole("img").hasAttribute("data-still")).toBe(true);
        expect(raf).not.toHaveBeenCalled();
        expect(canvas.fills()).toBeGreaterThan(0);
    });

    it("stops its loop when it goes away", () => {
        motion(false);
        stubCanvas();
        const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
        const cancel = vi.spyOn(window, "cancelAnimationFrame");
        const view = render(withMessages(<ThinkingOrb state="working" />));
        expect(raf).toHaveBeenCalled();
        view.unmount();
        expect(cancel).toHaveBeenCalledWith(7);
    });
});
