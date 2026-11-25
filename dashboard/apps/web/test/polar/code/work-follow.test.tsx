// @vitest-environment jsdom
/**
 * A Code turn's work block is open while the turn runs, folds when it ends
 * unless the person shows steps in detail, and a click still opens or folds it.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Work } from "@/components/polar/elements/work";

afterEach(cleanup);

function block(streaming: boolean, open: boolean) {
    return (
        <MessagesWrapper>
            <Work messageId="m" streaming={streaming} current="Running npm test" tools={1} failed={0} seconds={null} summary="1 step" follow={{ open }}>
                <p>step body</p>
            </Work>
        </MessagesWrapper>
    );
}

describe("Work that follows the turn", () => {
    it("is open while running and folds after", () => {
        const view = render(block(true, false));
        expect(screen.getByText("step body")).toBeTruthy();
        view.rerender(block(false, false));
        expect(screen.queryByText("step body")).toBeNull();
        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByText("step body")).toBeTruthy();
    });

    it("stays open after the turn when steps show in detail", () => {
        const view = render(block(true, true));
        view.rerender(block(false, true));
        expect(screen.getByText("step body")).toBeTruthy();
    });
});
