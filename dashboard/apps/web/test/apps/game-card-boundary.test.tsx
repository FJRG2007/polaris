// @vitest-environment jsdom

/**
 * One card that fails to draw stays one card: the rest of Settings keeps working,
 * and the failed one says which it was.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardBoundary } from "@polaris-app/game-servers/src/components/card-boundary";

afterEach(() => cleanup());

function Broken(): never {
    throw new Error("Element type is invalid");
}

describe("a card that fails", () => {
    it("is replaced by a note naming it, and its neighbours still draw", () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        render(
            <div>
                <CardBoundary name="Schedule">
                    <Broken />
                </CardBoundary>
                <CardBoundary name="Domain">
                    <p>Domain card</p>
                </CardBoundary>
            </div>
        );
        quiet.mockRestore();
        expect(screen.getByText("Schedule could not be shown")).toBeTruthy();
        expect(screen.getByText("Element type is invalid")).toBeTruthy();
        expect(screen.getByText("Domain card")).toBeTruthy();
    });
});
