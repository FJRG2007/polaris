/**
 * The two marks a task is read by, and what each of them has to say on its own.
 *
 * Both failures pinned here are invisible in a screenshot and obvious to
 * somebody using the board, which is the worst combination to leave untested.
 *
 * The first was live: done and closed both drew a tick, because the shape was
 * chosen by asking "has the clock stopped" - which is true of both. So a task
 * somebody cancelled, filed as a duplicate, or decided not to do was shown as a
 * task that had been completed, with the colour as the only thing saying which.
 *
 * The second is the reason the priority mark stopped being a flag. A flag
 * carries its meaning only in its colour: it says nothing to a reader who cannot
 * tell red from amber, nothing in grey, and it made "how urgent" a thing to look
 * up rather than see.
 */

import { describe, expect, it } from "vitest";
import { StatusIcon } from "@/app/(app)/tasks/pickers";
import { renderToStaticMarkup } from "react-dom/server";
import { PriorityMark } from "@/components/priority-mark";
import { TASK_PRIORITIES, TASK_STATUS_TYPES } from "@polaris/core";

/** The `d` of every path in the markup, which is where these shapes live. */
function paths(html: string): string[] {
    return [...html.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1] ?? "");
}

const TICK = "M5.8 10.3l2.7 2.7 5.7-5.7";

describe("what a status looks like", () => {
    it("gives finished work a tick", () => {
        expect(paths(renderToStaticMarkup(<StatusIcon color="#22c55e" type="done" />))).toContain(TICK);
    });

    it("does not give dropped work the same tick", () => {
        const html = renderToStaticMarkup(<StatusIcon color="#94a3b8" type="closed" />);
        expect(paths(html)).not.toContain(TICK);
        // A cross, drawn over the same solid disc: the clock stopped either way,
        // and what differs is whether the work happened.
        expect(paths(html).join(" ")).toMatch(/M6\.9 6\.9/);
    });

    it("draws every kind as its own shape", () => {
        // Colour is not allowed to be the only difference between any two of
        // them, so the markup has to differ too.
        const drawn = TASK_STATUS_TYPES.map((type) =>
            renderToStaticMarkup(<StatusIcon color="#000000" type={type} />)
        );
        expect(new Set(drawn).size).toBe(TASK_STATUS_TYPES.length);
    });
});

describe("what a priority looks like", () => {
    it("says how urgent in the shape, not only in the colour", () => {
        const drawn = TASK_PRIORITIES.map((priority) =>
            // One colour for all of them, so anything that still differs is
            // doing it with shape.
            renderToStaticMarkup(<PriorityMark priority={priority} />).replace(/#[0-9a-f]{6}/gi, "#000")
        );
        expect(new Set(drawn).size).toBe(TASK_PRIORITIES.length);
    });

    it("counts up: one solid bar for low, two for normal, three for high", () => {
        const solid = (priority: "low" | "normal" | "high") =>
            [...renderToStaticMarkup(<PriorityMark priority={priority} />).matchAll(/fill-opacity="1"/g)]
                .length;
        expect(solid("low")).toBe(1);
        expect(solid("normal")).toBe(2);
        expect(solid("high")).toBe(3);
    });

    it("draws something for a task nobody prioritised", () => {
        // Blank was the old behaviour, and a gap in a column where every other
        // row has a mark reads as "not loaded yet" as readily as "nobody said".
        const html = renderToStaticMarkup(<PriorityMark priority="none" />);
        expect(html).toContain("<svg");
        expect(html).toContain("No priority");
    });

    it("names itself, for a reader who is not looking at it", () => {
        for (const priority of TASK_PRIORITIES) {
            expect(renderToStaticMarkup(<PriorityMark priority={priority} />)).toContain('role="img"');
        }
    });
});
