import { describe, expect, it } from "vitest";
import * as motion from "@/lib/office/slide-motion";
import * as Y from "yjs";
import * as deck from "@/lib/office/deck";
import * as edits from "@/app/(app)/office/p/[id]/deck-edits";
import { buildSteps, computeNodeStates } from "@polaris/genoffice-slides/animation-play";

const one = (
    id: string,
    target: string,
    trigger: motion.Trigger = "onClick",
    effect: motion.EffectKind = "fade"
): motion.SlideAnimation => ({ id, target, effect, trigger, durationMs: 400, delayMs: 0 });

describe("transitions", () => {
    it("reads a stored transition and refuses anything else", () => {
        expect(motion.readTransition({ kind: "push", speed: "slow" })).toEqual({
            kind: "push",
            speed: "slow"
        });
        expect(motion.readTransition({ kind: "push", speed: "warp" })).toEqual({
            kind: "push",
            speed: "med"
        });
        expect(motion.readTransition({ kind: "morph" })).toEqual(motion.NO_TRANSITION);
        expect(motion.readTransition(null)).toEqual(motion.NO_TRANSITION);
    });

    it("settles random the same way in two windows, and never on random or none", () => {
        const random: motion.SlideTransition = { kind: "random", speed: "fast" };
        const a = motion.drawnTransition(random, "slide-1", 3);
        expect(motion.drawnTransition(random, "slide-1", 3)).toBe(a);
        expect(["none", "random"]).not.toContain(a);
        const seen = new Set(
            Array.from({ length: 40 }, (_, turn) => motion.drawnTransition(random, "s", turn))
        );
        expect(seen.size).toBeGreaterThan(3);
        expect(motion.drawnTransition({ kind: "wipe", speed: "med" }, "s", 0)).toBe("wipe");
    });

    it("draws each transition from the old slide to the new one", () => {
        expect(motion.transitionFrame("fade", 0).to).toEqual({ opacity: 0 });
        expect(motion.transitionFrame("fade", 1).to).toEqual({ opacity: 1 });
        expect(motion.transitionFrame("push", 1).to).toEqual({ transform: "translateY(0.000%)" });
        expect(motion.transitionFrame("push", 0).to).toEqual({
            transform: "translateY(100.000%)"
        });
        expect(motion.transitionFrame("wipe", 0.5).to.clipPath).toBe("inset(0 0 0 50.000%)");
        expect(motion.transitionFrame("split", 1).to.clipPath).toBe("inset(0.000% 0 0.000% 0)");
        const pull = motion.transitionFrame("pull", 1);
        expect(pull.fromOnTop).toBe(true);
        expect(pull.from.transform).toBe("translateX(-100.000%)");
        for (const kind of motion.TRANSITIONS) {
            if (kind === "random") continue;
            expect(motion.transitionFrame(kind, 0.3)).toBeTruthy();
        }
    });
});

describe("animations", () => {
    it("reads a stored list, clamping times and leaving out what is not an animation", () => {
        const read = motion.readAnimations([
            {
                id: "a",
                target: "box",
                effect: "flyIn",
                trigger: "afterPrev",
                durationMs: 5,
                delayMs: -4
            },
            { id: "b", target: "box", effect: "motionPath", trigger: "onClick" },
            "junk",
            { id: "c", target: "box", effect: "spin", trigger: "sideways", durationMs: 10 ** 9 }
        ]);
        expect(read).toEqual([
            {
                id: "a",
                target: "box",
                effect: "flyIn",
                trigger: "afterPrev",
                durationMs: motion.DURATION_MIN,
                delayMs: 0
            },
            {
                id: "c",
                target: "box",
                effect: "spin",
                trigger: "onClick",
                durationMs: motion.DURATION_MAX,
                delayMs: 0
            }
        ]);
        expect(motion.readAnimations({})).toEqual([]);
    });

    it("animates a group as one, and drops what has nothing left to move", () => {
        const boxes = [
            { id: "a", group: "g" },
            { id: "b", group: "g" },
            { id: "c", group: "" }
        ];
        expect(motion.targetOf(boxes[0]!)).toBe("group:g");
        expect(motion.targetOf(boxes[2]!)).toBe("c");
        expect(motion.membersOf("group:g", boxes).map((box) => box.id)).toEqual(["a", "b"]);
        const list = [one("1", "group:g"), one("2", "c"), one("3", "gone"), one("4", "group:x")];
        expect(motion.liveAnimations(list, boxes).map((item) => item.id)).toEqual(["1", "2"]);
    });

    it("moves, copies and ungroups animations", () => {
        const list = [one("1", "a"), one("2", "b"), one("3", "group:g")];
        expect(motion.moveAnimation(list, "3", -1).map((item) => item.id)).toEqual(["1", "3", "2"]);
        expect(motion.moveAnimation(list, "1", -1).map((item) => item.id)).toEqual(["1", "2", "3"]);
        let n = 0;
        const ids = (): string => `new${++n}`;
        const copied = motion.remapAnimations(list, new Map([["a", "A"]]), ids);
        expect(copied.map((item) => item.target)).toEqual(["A", "b", "group:g"]);
        expect(copied.map((item) => item.id)).toEqual(["new1", "new2", "new3"]);
        const apart = motion.ungroupAnimations(list, "g", ["x", "y"], ids);
        expect(apart.slice(2).map((item) => [item.id, item.target, item.trigger])).toEqual([
            ["3", "x", "onClick"],
            ["new4", "y", "withPrev"]
        ]);
    });

    it("groups animations into click steps with GenOffice's engine", () => {
        const list = [
            one("1", "a", "withPrev"),
            one("2", "b", "afterPrev"),
            one("3", "c", "onClick"),
            one("4", "d", "withPrev")
        ];
        const steps = buildSteps(motion.playItems(list));
        expect(steps.map((step) => [step.auto, step.items.length])).toEqual([
            [true, 2],
            [false, 2]
        ]);
        // Before anything plays an entrance's box is hidden; after its step, shown.
        const before = computeNodeStates(steps, 0, null, 100, 100);
        expect(before.get("a")?.hidden).toBe(true);
        const after = computeNodeStates(steps, 1, null, 100, 100);
        expect(after.get("a")?.hidden).toBe(false);
        expect(after.get("c")?.hidden).toBe(true);
    });
});

describe("a show", () => {
    // Slide 0: two click steps. Slide 1: none. Slide 2: one step that plays itself.
    const plan: motion.SlideSteps[] = [
        { count: 2, auto: false },
        { count: 0, auto: false },
        { count: 1, auto: true }
    ];
    const stepsOf = (slide: number): motion.SlideSteps => plan[slide] ?? { count: 0, auto: false };
    const walk = (to: "next" | "previous", from: motion.ShowAt, times: number): motion.ShowAt[] => {
        const out: motion.ShowAt[] = [];
        let at = from;
        for (let i = 0; i < times; i++) {
            at = motion.stepShow(at, to, plan.length, stepsOf);
            out.push(at);
        }
        return out;
    };

    it("plays each step before turning the slide, then ends", () => {
        expect(walk("next", { slide: 0, played: 0 }, 6)).toEqual([
            { slide: 0, played: 1 },
            { slide: 0, played: 2 },
            { slide: 1, played: 0 },
            { slide: 2, played: 1 },
            { slide: 3, played: 0 },
            { slide: 3, played: 0 }
        ]);
    });

    it("goes back a step at a time, and to the slide before as it was left", () => {
        expect(walk("previous", { slide: 3, played: 0 }, 6)).toEqual([
            { slide: 2, played: 1 },
            { slide: 1, played: 0 },
            { slide: 0, played: 2 },
            { slide: 0, played: 1 },
            { slide: 0, played: 0 },
            { slide: 0, played: 0 }
        ]);
        expect(motion.stepShow({ slide: 1, played: 0 }, "last", 3, stepsOf)).toEqual({
            slide: 2,
            played: 1
        });
    });

    it("draws a step, a turn and a jump", () => {
        expect(
            motion.moveBetween({ slide: 0, played: 0 }, { slide: 0, played: 1 }, stepsOf)
        ).toEqual({
            kind: "step",
            step: 0
        });
        expect(
            motion.moveBetween({ slide: 1, played: 0 }, { slide: 2, played: 1 }, stepsOf)
        ).toEqual({
            kind: "turn",
            from: 1,
            autoStep: true
        });
        expect(
            motion.moveBetween({ slide: 2, played: 1 }, { slide: 1, played: 0 }, stepsOf)
        ).toEqual({
            kind: "jump"
        });
    });
});

describe("a box mid-animation", () => {
    const frame = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
    const rest: motion.MotionState = {
        hidden: false,
        opacity: 1,
        scale: 1,
        scaleX: 1,
        rotationDeg: 0,
        dx: 0,
        dy: 0,
        clip: null
    };

    it("leaves a box at rest alone", () => {
        expect(motion.motionStyle(rest, frame)).toEqual({});
    });

    it("turns and scales about the box's middle, and moves by the slide", () => {
        const style = motion.motionStyle({ ...rest, scale: 0.5, dy: 30, rotationDeg: 90 }, frame);
        expect(style.transform).toBe(
            "translate(0.000%, 30.000%) rotate(90.000deg) scale(0.5000, 0.5000)"
        );
        expect(style.transformOrigin).toBe("30.000% 45.000%");
    });

    it("cuts a wipe to the part shown so far", () => {
        const style = motion.motionStyle({ ...rest, clip: { t: 0.5, mode: "btm" } }, frame);
        // Half the box hidden from the top: 0.2 + 0.25 down, 0.3 up from the bottom.
        expect(style.clipPath).toBe("inset(45.000% 50.000% 30.000% 10.000%)");
        expect(motion.motionStyle({ ...rest, hidden: true }, frame).visibility).toBe("hidden");
    });
});

describe("motion in the shared deck", () => {
    const setup = () => {
        const doc = new Y.Doc();
        const slide = edits.addSlide(doc, 0, "blank");
        const a = edits.addBox(doc, slide, "shape");
        const b = edits.addBox(doc, slide, "shape");
        return { doc, slide, a, b };
    };
    const animationsOn = (doc: Y.Doc, slide: string) =>
        motion.readAnimations(edits.animationsOf(doc).get(slide));

    it("sets transitions on one slide or all, and none clears them", () => {
        const { doc, slide } = setup();
        const other = edits.addSlide(doc, 1, "blank");
        edits.setTransition(doc, [slide, other], { kind: "push", speed: "fast" });
        expect(motion.readTransition(edits.transitionsOf(doc).get(other))).toEqual({
            kind: "push",
            speed: "fast"
        });
        edits.setTransition(doc, [slide], motion.NO_TRANSITION);
        expect(edits.transitionsOf(doc).has(slide)).toBe(false);
    });

    it("copies a slide's motion onto the copied boxes, and forgets a deleted slide's", () => {
        const { doc, slide, a } = setup();
        edits.setTransition(doc, [slide], { kind: "fade", speed: "slow" });
        edits.setAnimations(doc, slide, [one("x", a, "onClick", "flyIn")]);
        const copy = edits.duplicateSlide(doc, slide, 0);
        const copied = animationsOn(doc, copy);
        const copiedBoxes = deck.boxesOn(copy, new Map(edits.boxesOf(doc).entries()));
        expect(copied).toHaveLength(1);
        expect(copied[0]!.target).not.toBe(a);
        expect(copiedBoxes.map((box) => box.id)).toContain(copied[0]!.target);
        expect(motion.readTransition(edits.transitionsOf(doc).get(copy)).kind).toBe("fade");
        edits.removeSlide(doc, copy);
        expect(edits.animationsOf(doc).has(copy)).toBe(false);
        expect(edits.transitionsOf(doc).has(copy)).toBe(false);
    });

    it("turns a group's animation into each box's when the group is taken apart", () => {
        const { doc, slide, a, b } = setup();
        const group = edits.groupBoxes(doc, slide, [a, b]);
        edits.setAnimations(doc, slide, [one("g", `group:${group}`, "onClick", "zoom")]);
        edits.ungroupBoxes(doc, slide, [a, b]);
        const after = animationsOn(doc, slide);
        expect(after.map((item) => [item.target, item.trigger])).toEqual([
            [a, "onClick"],
            [b, "withPrev"]
        ]);
    });

    it("is taken back by undo like any other change", () => {
        const { doc, slide, a } = setup();
        const history = edits.deckUndoManager(doc);
        edits.setAnimations(doc, slide, [one("x", a)]);
        expect(animationsOn(doc, slide)).toHaveLength(1);
        history.undo();
        expect(animationsOn(doc, slide)).toHaveLength(0);
    });
});
