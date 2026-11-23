// @vitest-environment jsdom

/**
 * The progress bar: a fill clamped to the track, the moving light only while
 * there is work left to show, and a stripe when there is no number yet.
 */

import { ProgressBar } from "../src/components/progress-bar";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function fill(): HTMLElement {
    return screen.getByRole("progressbar").firstElementChild as HTMLElement;
}

describe("ProgressBar", () => {
    it("passes the accessible name and value to the track", () => {
        render(<ProgressBar value={30} aria-label="Cases answered" aria-valuenow={30} />);
        const bar = screen.getByRole("progressbar", { name: "Cases answered" });
        expect(bar.getAttribute("aria-valuenow")).toBe("30");
        expect(fill().style.width).toBe("30%");
    });

    it("sweeps a light along a fill that is moving", () => {
        render(<ProgressBar value={30} />);
        expect(fill().className).toContain("progress-shimmer");
    });

    it("keeps still when empty, full, or told not to move", () => {
        const { rerender } = render(<ProgressBar value={0} />);
        expect(fill().className).not.toContain("progress-shimmer");
        rerender(<ProgressBar value={100} />);
        expect(fill().className).not.toContain("progress-shimmer");
        rerender(<ProgressBar value={40} animated={false} />);
        expect(fill().className).not.toContain("progress-shimmer");
    });

    it("clamps a value outside 0-100 to the track", () => {
        const { rerender } = render(<ProgressBar value={140} />);
        expect(fill().style.width).toBe("100%");
        rerender(<ProgressBar value={-5} />);
        expect(fill().style.width).toBe("0%");
    });

    it("draws a pulsing stripe when there is no number yet", () => {
        render(<ProgressBar value={null} />);
        expect(fill().className).toContain("animate-pulse");
        expect(fill().style.width).toBe("");
    });

    it("colours the fill by tone", () => {
        render(<ProgressBar value={90} tone="danger" />);
        expect(fill().className).toContain("bg-danger");
    });
});
