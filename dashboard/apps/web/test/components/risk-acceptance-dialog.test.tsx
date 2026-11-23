// @vitest-environment jsdom

/**
 * The risk-acceptance dialog: nothing changes until the box is ticked and the
 * confirm button pressed, Keep leaves everything as it was, and the box starts
 * unticked every time it opens.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RiskAcceptanceDialog } from "@/components/risk-acceptance-dialog";

const copy = {
    title: "Take the risk?",
    description: "Something bad could happen.",
    accept: "I accept the risk.",
    keep: "Keep it safe",
    confirm: "Accept and save"
};

afterEach(cleanup);

function draw(open: boolean, onKeep = vi.fn(), onAccept = vi.fn()) {
    return { onKeep, onAccept, ...render(<RiskAcceptanceDialog open={open} copy={copy} onKeep={onKeep} onAccept={onAccept} />) };
}

const confirm = () => screen.getByRole("button", { name: "Accept and save" }) as HTMLButtonElement;
const box = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("RiskAcceptanceDialog", () => {
    it("says what is at stake and keeps confirm off until the risk is accepted", () => {
        const { onAccept } = draw(true);
        expect(screen.getByText("Take the risk?")).toBeTruthy();
        expect(screen.getByText("Something bad could happen.")).toBeTruthy();
        expect(confirm().disabled).toBe(true);
        fireEvent.click(confirm());
        expect(onAccept).not.toHaveBeenCalled();
        fireEvent.click(box());
        expect(confirm().disabled).toBe(false);
        fireEvent.click(confirm());
        expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("keeps everything as it was from the keep button", () => {
        const { onKeep, onAccept } = draw(true);
        fireEvent.click(screen.getByRole("button", { name: "Keep it safe" }));
        expect(onKeep).toHaveBeenCalledTimes(1);
        expect(onAccept).not.toHaveBeenCalled();
    });

    it("starts unticked every time it opens", () => {
        const onKeep = vi.fn();
        const onAccept = vi.fn();
        const view = render(<RiskAcceptanceDialog open copy={copy} onKeep={onKeep} onAccept={onAccept} />);
        fireEvent.click(box());
        expect(box().checked).toBe(true);
        view.rerender(<RiskAcceptanceDialog open={false} copy={copy} onKeep={onKeep} onAccept={onAccept} />);
        view.rerender(<RiskAcceptanceDialog open copy={copy} onKeep={onKeep} onAccept={onAccept} />);
        expect(box().checked).toBe(false);
    });

    it("draws nothing while closed", () => {
        draw(false);
        expect(screen.queryByText("Take the risk?")).toBeNull();
    });
});
