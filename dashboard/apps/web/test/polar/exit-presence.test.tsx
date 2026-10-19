// @vitest-environment jsdom
/**
 * Polar's side panel and the page's phone drawer leave the way they came: the
 * element stays mounted in its closing state until its exit animation ends, and
 * goes anyway when no animation ever reports back.
 */

import { useExitPresence } from "@/lib/use-exit-presence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

function Panel({ open }: { open: boolean }) {
    const presence = useExitPresence(open);
    if (!presence.mounted) return null;
    return (
        <aside
            aria-label="Panel"
            data-state={presence.state}
            onAnimationEnd={presence.onAnimationEnd}
        >
            <span data-testid="inner">inner</span>
        </aside>
    );
}

/** jsdom has no CSS animations, so React may listen under the prefixed name. */
function animationEnd(element: Element) {
    for (const type of ["animationend", "webkitAnimationEnd"])
        fireEvent(element, new Event(type, { bubbles: true }));
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("useExitPresence", () => {
    it("mounts open, and stays mounted while it animates out", () => {
        const view = render(<Panel open />);
        expect(screen.getByLabelText("Panel").dataset.state).toBe("open");
        view.rerender(<Panel open={false} />);
        expect(screen.getByLabelText("Panel").dataset.state).toBe("closed");
        animationEnd(screen.getByLabelText("Panel"));
        expect(screen.queryByLabelText("Panel")).toBeNull();
    });

    it("ignores an animation of something inside it", () => {
        const view = render(<Panel open />);
        view.rerender(<Panel open={false} />);
        animationEnd(screen.getByTestId("inner"));
        expect(screen.getByLabelText("Panel")).toBeTruthy();
    });

    it("goes anyway when no animation ever ends", () => {
        vi.useFakeTimers();
        const view = render(<Panel open />);
        view.rerender(<Panel open={false} />);
        expect(screen.getByLabelText("Panel")).toBeTruthy();
        act(() => void vi.advanceTimersByTime(500));
        expect(screen.queryByLabelText("Panel")).toBeNull();
    });

    it("comes back open when reopened halfway out, and nothing is mounted closed", () => {
        vi.useFakeTimers();
        const view = render(<Panel open={false} />);
        expect(screen.queryByLabelText("Panel")).toBeNull();
        view.rerender(<Panel open />);
        view.rerender(<Panel open={false} />);
        view.rerender(<Panel open />);
        act(() => void vi.advanceTimersByTime(500));
        expect(screen.getByLabelText("Panel").dataset.state).toBe("open");
    });
});
