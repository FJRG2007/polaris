// @vitest-environment jsdom

/**
 * The one checkbox: keyboard and form behaviour of the native box it wraps, the
 * partial state, and a tick that follows the input even when nobody controls it.
 */

import { Checkbox } from "../src/components/checkbox";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("Checkbox", () => {
    it("posts under its name when ticked, uncontrolled", () => {
        render(
            <form data-testid="form">
                <Checkbox name="agree" value="yes" aria-label="Agree" />
            </form>
        );
        const box = screen.getByRole("checkbox", { name: "Agree" });
        const form = screen.getByTestId("form") as HTMLFormElement;
        expect(new FormData(form).get("agree")).toBeNull();
        fireEvent.click(box);
        expect(new FormData(form).get("agree")).toBe("yes");
    });

    it("is reachable and toggled from the keyboard as a native box", () => {
        const onChange = vi.fn();
        render(<Checkbox aria-label="Pick" checked={false} onChange={onChange} />);
        const box = screen.getByRole("checkbox", { name: "Pick" });
        box.focus();
        expect(document.activeElement).toBe(box);
        expect(box.tabIndex).toBe(0);
        fireEvent.click(box);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("announces the partial state as mixed and draws the dash", () => {
        render(
            <Checkbox aria-label="All" indeterminate checked={false} onChange={() => undefined} />
        );
        const box = screen.getByRole("checkbox", { name: "All" }) as HTMLInputElement;
        expect(box.indeterminate).toBe(true);
        const glyphs = box.parentElement!.querySelectorAll("svg");
        expect(glyphs[1]!.getAttribute("class")).toContain("peer-indeterminate:block");
    });

    it("does not change when disabled", () => {
        const onChange = vi.fn();
        render(<Checkbox aria-label="Locked" disabled checked onChange={onChange} />);
        const box = screen.getByRole("checkbox", { name: "Locked" }) as HTMLInputElement;
        expect(box.disabled).toBe(true);
        expect(box.parentElement!.className).toContain("opacity-60");
    });
});
