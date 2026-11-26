// @vitest-environment jsdom
/**
 * The composer's send button: Send between turns, Stop mid-turn, and once Stop
 * was pressed a waiting "Stopping..." that cannot be pressed again until the
 * turn has ended.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptInputSubmit } from "@/components/polar/elements/prompt-input";

afterEach(cleanup);

const LABELS = { sendLabel: "Send", stopLabel: "Stop", stoppingLabel: "Stopping..." };

describe("the send button", () => {
    it("sends between turns", () => {
        render(<PromptInputSubmit busy={false} disabled={false} onStop={vi.fn()} {...LABELS} />);
        expect(screen.getByRole("button", { name: "Send" }).getAttribute("type")).toBe("submit");
    });

    it("stops mid-turn", () => {
        const onStop = vi.fn();
        render(<PromptInputSubmit busy disabled={false} onStop={onStop} {...LABELS} />);
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(onStop).toHaveBeenCalledOnce();
    });

    it("says Stopping and waits once Stop was pressed", () => {
        const onStop = vi.fn();
        render(<PromptInputSubmit busy stopping disabled={false} onStop={onStop} {...LABELS} />);
        const button = screen.getByRole("button", { name: "Stopping..." }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        fireEvent.click(button);
        expect(onStop).not.toHaveBeenCalled();
    });

    it("offers Send again once the turn has ended, whatever stopping says", () => {
        render(<PromptInputSubmit busy={false} stopping disabled={false} onStop={vi.fn()} {...LABELS} />);
        expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    });
});
