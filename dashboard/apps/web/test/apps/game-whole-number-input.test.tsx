// @vitest-environment jsdom

/**
 * A bounded number field takes any number typed digit by digit, and holds it to
 * its bounds only when it is left: "15" in a field that starts at 2 is 15, not 25.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WholeNumberInput } from "@polaris-app/game-servers/src/components/whole-number-input";

afterEach(cleanup);

function field(value: number, onValueChange: (value: number) => void) {
    render(
        <WholeNumberInput
            min={2}
            max={600}
            value={value}
            onValueChange={onValueChange}
            aria-label="Seconds"
        />
    );
    return screen.getByLabelText("Seconds") as HTMLInputElement;
}

describe("WholeNumberInput", () => {
    it("keeps what is typed until the field is left", () => {
        const change = vi.fn();
        const input = field(5, change);
        fireEvent.change(input, { target: { value: "1" } });
        expect(input.value).toBe("1");
        fireEvent.change(input, { target: { value: "15" } });
        expect(change).not.toHaveBeenCalled();
        fireEvent.blur(input);
        expect(change).toHaveBeenCalledWith(15);
    });

    it("holds a value to its bounds when it is committed", () => {
        const change = vi.fn();
        const input = field(5, change);
        fireEvent.change(input, { target: { value: "1" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(change).toHaveBeenCalledWith(2);
        fireEvent.change(input, { target: { value: "9000" } });
        fireEvent.blur(input);
        expect(change).toHaveBeenLastCalledWith(600);
    });

    it("goes back to the value when left empty", () => {
        const change = vi.fn();
        const input = field(5, change);
        fireEvent.change(input, { target: { value: "" } });
        fireEvent.blur(input);
        expect(change).not.toHaveBeenCalled();
        expect(input.value).toBe("5");
    });
});
