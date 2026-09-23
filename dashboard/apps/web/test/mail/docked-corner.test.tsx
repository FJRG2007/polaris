// @vitest-environment jsdom

/**
 * What a panel docked in the bottom right corner tells the rest of the screen.
 *
 * The behaviour, rather than the class strings the sibling test pins: that the
 * height is published the moment the panel is there, republished when it changes
 * size, and - the one that matters most - taken away again. A length left behind
 * after the composer closes is every later upload floating in the middle of an
 * empty screen, which is a stranger bug than the one this fixed.
 */

import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKED_HEIGHT, useDockedCorner } from "@/components/docked-corner";

/** jsdom has no ResizeObserver, and no layout either - so the box says what the
 *  test wants it to and the observer is a way to ask for another reading. */
let resized: (() => void)[] = [];

class FakeResizeObserver {
    public constructor(private readonly run: () => void) {
        resized.push(run);
    }
    public observe(): void {}
    public disconnect(): void {
        resized = resized.filter((one) => one !== this.run);
    }
}

function Panel({ docked, height }: { docked: boolean; height: number }) {
    const node = useRef<HTMLDivElement | null>(null);
    useDockedCorner(node, docked);
    return (
        <div
            ref={(element) => {
                node.current = element;
                if (element) element.getBoundingClientRect = () => ({ height }) as DOMRect;
            }}
        />
    );
}

const published = (): string => document.body.style.getPropertyValue(DOCKED_HEIGHT);

beforeEach(() => {
    resized = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
    cleanup();
    document.body.style.removeProperty(DOCKED_HEIGHT);
    vi.unstubAllGlobals();
});

describe("a panel docked in the corner", () => {
    it("says how tall it is as soon as it is there", () => {
        render(<Panel docked height={608} />);
        expect(published()).toBe("608px");
    });

    it("says it again when it changes size", () => {
        const view = render(<Panel docked height={608} />);
        view.rerender(<Panel docked height={320} />);
        for (const run of resized) run();
        expect(published()).toBe("320px");
    });

    it("says nothing when it is not docked", () => {
        // The composer taking the whole screen: there is no corner left to sit
        // above, so the card floats over it instead.
        render(<Panel docked={false} height={608} />);
        expect(published()).toBe("");
    });

    it("gives the corner back when it goes", () => {
        const view = render(<Panel docked height={608} />);
        expect(published()).toBe("608px");
        view.unmount();
        expect(published()).toBe("");
    });

    it("gives it back when it stops being docked without going", () => {
        const view = render(<Panel docked height={608} />);
        view.rerender(<Panel docked={false} height={608} />);
        expect(published()).toBe("");
    });
});
