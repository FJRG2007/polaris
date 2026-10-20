// @vitest-environment jsdom
/**
 * Polar's avatar sleeps where nothing of Polar is open or the tab is offline,
 * hops while Polar answers, names its state for a screen reader in both
 * languages, draws one still frame for someone who asked for less motion, and
 * never leaves a loop running once it is gone.
 */

import { stubCanvas } from "./canvas-stub";
import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PolarAvatar } from "@/components/polar/motion/polar-avatar";
import {
    AVATAR_STATES,
    Sim,
    avatarStateFor,
    restPose
} from "@/components/polar/motion/avatar-engine";

describe("which state the avatar shows", () => {
    it("sleeps while offline or while nothing of Polar is open", () => {
        expect(avatarStateFor({ open: false, online: true, busy: false })).toBe("sleeping");
        expect(avatarStateFor({ open: true, online: false, busy: true })).toBe("sleeping");
    });

    it("works while Polar answers and looks around otherwise", () => {
        expect(avatarStateFor({ open: true, online: true, busy: true })).toBe("working");
        expect(avatarStateFor({ open: true, online: true, busy: false })).toBe("idle");
    });
});

describe("the rig", () => {
    const run = (sim: Sim, seconds: number, each?: () => void) => {
        for (let i = 0; i < seconds * 60; i++) {
            sim.update(1 / 60);
            each?.();
        }
    };

    it("hops off the ground while working, and stays down asleep", () => {
        const working = new Sim(0.3, "working");
        let highest = 0;
        run(working, 3, () => (highest = Math.min(highest, working.pose.y)));
        expect(highest).toBeLessThan(-10);

        const sleeping = new Sim(0.3, "sleeping");
        let lowest = 0;
        run(sleeping, 3, () => (lowest = Math.min(lowest, sleeping.pose.y)));
        expect(lowest).toBeGreaterThan(-1);
    });

    it("jumps when poked, whatever the state", () => {
        const sim = new Sim(0.7, "sleeping");
        run(sim, 1);
        sim.poke();
        let highest = 0;
        run(sim, 1, () => (highest = Math.min(highest, sim.pose.y)));
        expect(highest).toBeLessThan(-15);
    });

    it("eases its blend weights to the new state", () => {
        const sim = new Sim(0.5, "idle");
        sim.setState("working");
        run(sim, 0.2);
        expect(sim.pose.w[1]).toBeGreaterThan(0);
        expect(sim.pose.w[1]).toBeLessThan(1);
        run(sim, 2);
        expect(sim.pose.w).toEqual([0, 1, 0]);
    });

    it("turns its head toward the pointer", () => {
        const sim = new Sim(0.9, "idle");
        sim.setPointer(1, 0, 1);
        run(sim, 2);
        expect(sim.pose.lookX).toBeGreaterThan(0);
    });

    it("has a still pose for every state", () => {
        for (const state of AVATAR_STATES) {
            const pose = restPose(state);
            expect(pose.w.reduce((a, b) => a + b, 0)).toBe(1);
            expect(pose.y).toBeGreaterThanOrEqual(0);
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
    vi.stubGlobal(
        "Path2D",
        class {
            ellipse() {}
            moveTo() {}
            arc() {}
        }
    );
}

describe("the avatar", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is an image named for its state", () => {
        motion(false);
        render(withMessages(<PolarAvatar state="working" />));
        expect(screen.getByRole("img", { name: "Polar, working" })).toBeTruthy();
    });

    it("speaks Spanish too", () => {
        motion(false);
        render(withMessages(<PolarAvatar state="sleeping" />, "es-ES"));
        expect(screen.getByRole("img", { name: "Polar, dormido" })).toBeTruthy();
    });

    it("keeps a layout box of its size, however far it hops", () => {
        motion(false);
        render(withMessages(<PolarAvatar size={20} />));
        const box = screen.getByRole("img").parentElement!;
        expect(box.style.width).toBe("20px");
        expect(box.style.height).toBe("20px");
    });

    it("draws one still frame, starts no loop and ignores clicks under reduced motion", () => {
        motion(true);
        const canvas = stubCanvas();
        const raf = vi.spyOn(window, "requestAnimationFrame");
        render(withMessages(<PolarAvatar state="idle" size={64} />));
        const img = screen.getByRole("img");
        expect(img.hasAttribute("data-still")).toBe(true);
        expect(canvas.fills()).toBeGreaterThan(0);
        const painted = canvas.fills();
        fireEvent.click(img);
        expect(raf).not.toHaveBeenCalled();
        expect(canvas.fills()).toBe(painted);
    });

    it("stops its loop when it goes away", () => {
        motion(false);
        stubCanvas();
        const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(9);
        const cancel = vi.spyOn(window, "cancelAnimationFrame");
        const view = render(withMessages(<PolarAvatar state="working" />));
        expect(raf).toHaveBeenCalled();
        view.unmount();
        expect(cancel).toHaveBeenCalledWith(9);
    });
});
