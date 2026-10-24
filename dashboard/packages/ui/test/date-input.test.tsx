// @vitest-environment jsdom

/**
 * The date field: the native value format, a form posting it under its name,
 * the calendar driven from the keyboard, and days outside min/max refused.
 */

import { DateInput } from "../src/components/date-input";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function openCalendar(name = "Due") {
    fireEvent.click(screen.getByRole("button", { name }));
    return screen.getByRole("grid");
}

describe("DateInput", () => {
    it("posts the native YYYY-MM-DD string under its name", () => {
        render(
            <form data-testid="form">
                <DateInput name="due" defaultValue="2026-03-14" aria-label="Due" />
            </form>
        );
        const form = screen.getByTestId("form") as HTMLFormElement;
        expect(new FormData(form).get("due")).toBe("2026-03-14");
    });

    it("moves by day, week and month from the keyboard and picks with Enter", () => {
        const onChange = vi.fn();
        render(<DateInput value="2026-03-14" onChange={onChange} aria-label="Due" name="due" />);
        const grid = openCalendar();
        expect(document.activeElement?.getAttribute("data-day")).toBe("2026-03-14");
        fireEvent.keyDown(grid, { key: "ArrowRight" });
        expect(document.activeElement?.getAttribute("data-day")).toBe("2026-03-15");
        fireEvent.keyDown(grid, { key: "ArrowDown" });
        expect(document.activeElement?.getAttribute("data-day")).toBe("2026-03-22");
        fireEvent.keyDown(grid, { key: "PageDown" });
        expect(document.activeElement?.getAttribute("data-day")).toBe("2026-04-22");
        fireEvent.keyDown(grid, { key: "Enter" });
        expect(onChange).toHaveBeenCalledWith({
            target: { value: "2026-04-22", name: "due" },
            currentTarget: { value: "2026-04-22", name: "due" }
        });
    });

    it("refuses days outside min and max", () => {
        const onChange = vi.fn();
        render(
            <DateInput
                value="2026-03-14"
                min="2026-03-10"
                max="2026-03-20"
                onChange={onChange}
                aria-label="Due"
            />
        );
        openCalendar();
        const early = document.querySelector<HTMLButtonElement>('[data-day="2026-03-09"]')!;
        const late = document.querySelector<HTMLButtonElement>('[data-day="2026-03-21"]')!;
        expect(early.disabled).toBe(true);
        expect(late.disabled).toBe(true);
        fireEvent.click(early);
        expect(onChange).not.toHaveBeenCalled();
        const grid = screen.getByRole("grid");
        for (let step = 0; step < 7; step++) fireEvent.keyDown(grid, { key: "ArrowRight" });
        fireEvent.keyDown(grid, { key: "Enter" });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("is cleared with its clear button, and not offered one when required", () => {
        const onValueChange = vi.fn();
        const { rerender } = render(
            <DateInput value="2026-03-14" onValueChange={onValueChange} aria-label="Due" />
        );
        act(() => fireEvent.click(screen.getAllByRole("button", { name: /clear/i })[0]!));
        expect(onValueChange).toHaveBeenCalledWith("");
        rerender(<DateInput value="2026-03-14" required aria-label="Due" />);
        expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    });

    it("keeps the time when the day changes in datetime mode", () => {
        const onValueChange = vi.fn();
        render(
            <DateInput
                mode="datetime"
                value="2026-03-14T18:30"
                onValueChange={onValueChange}
                aria-label="Due"
            />
        );
        openCalendar();
        fireEvent.click(document.querySelector('[data-day="2026-03-16"]')!);
        expect(onValueChange).toHaveBeenCalledWith("2026-03-16T18:30");
    });
});
