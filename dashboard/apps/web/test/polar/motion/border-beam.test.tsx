// @vitest-environment jsdom
/**
 * The composer's beam runs only while Polar streams, fades out instead of
 * vanishing, takes its colours from the theme and stays away entirely for
 * someone who asked for less motion.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BorderBeam, beamCss } from "@/components/polar/motion/border-beam";

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

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the beam's stylesheet", () => {
    it("is scoped to its own beam and coloured by the theme tokens", () => {
        const css = beamCss("b1", 12, true);
        expect(css).toContain('[data-beam="b1"]');
        expect(css).toContain("hsl(var(--primary)");
        expect(css).toContain("@keyframes beam-spin-b1");
        expect(css).not.toMatch(/rgb\(255, 50, 100\)/);
        expect(css).toContain("inset(0 round 12px)");
    });

    it("inks the light theme dark and the dark theme light", () => {
        expect(beamCss("b", 8, true)).toContain("rgba(255, 255, 255, 0.75)");
        expect(beamCss("b", 8, false)).toContain("rgba(0, 0, 0, 0.55)");
    });
});

describe("the beam", () => {
    it("runs while active and fades when it stops", () => {
        motion(false);
        const view = render(
            <BorderBeam active>
                <form />
            </BorderBeam>
        );
        const wrapper = view.container.firstElementChild!;
        expect(wrapper.hasAttribute("data-active")).toBe(true);
        view.rerender(
            <BorderBeam active={false}>
                <form />
            </BorderBeam>
        );
        expect(wrapper.hasAttribute("data-active")).toBe(false);
        expect(wrapper.hasAttribute("data-fading")).toBe(true);
    });

    it("draws nothing under reduced motion", () => {
        motion(true);
        const view = render(
            <BorderBeam active>
                <form />
            </BorderBeam>
        );
        const wrapper = view.container.firstElementChild!;
        expect(wrapper.hasAttribute("data-active")).toBe(false);
        expect(view.container.querySelector("style")).toBeNull();
    });
});
