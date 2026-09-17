// @vitest-environment jsdom

/**
 * The line between two panels: dragged within its limits, and put back from a
 * right-click on the line itself.
 */

import { ResizeHandle } from "@polaris/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

function handle(props: Partial<Parameters<typeof ResizeHandle>[0]> = {}) {
    const onChange = vi.fn();
    render(
        <ResizeHandle
            axis="x"
            size={300}
            min={200}
            max={400}
            onChange={onChange}
            label="List width"
            {...props}
        />
    );
    return { onChange, line: screen.getByRole("separator", { name: "List width" }) };
}

describe("moving the line", () => {
    it("never goes past its limits", () => {
        const { onChange, line } = handle({ size: 390 });
        fireEvent.keyDown(line, { key: "ArrowRight" });
        expect(onChange).toHaveBeenLastCalledWith(400);
        fireEvent.keyDown(line, { key: "Home" });
        expect(onChange).toHaveBeenLastCalledWith(200);
    });
});

describe("the right-click menu on the line", () => {
    it("puts this panel back, or every panel", async () => {
        const onReset = vi.fn();
        const onResetAll = vi.fn();
        const { line } = handle({ onReset, onResetAll });

        fireEvent.contextMenu(line);
        fireEvent.click(await screen.findByRole("menuitem", { name: "Reset to default" }));
        expect(onReset).toHaveBeenCalledTimes(1);

        fireEvent.contextMenu(line);
        fireEvent.click(await screen.findByRole("menuitem", { name: "Reset layout" }));
        expect(onResetAll).toHaveBeenCalledTimes(1);
    });

    it("offers only what the screen can do", async () => {
        const { line } = handle({ onReset: vi.fn() });
        fireEvent.contextMenu(line);
        expect(await screen.findByRole("menuitem", { name: "Reset to default" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Reset layout" })).toBeNull();
    });

    it("has no menu of its own when there is nothing to put back", () => {
        const { line } = handle();
        fireEvent.contextMenu(line);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("still resets on a double press", () => {
        const onReset = vi.fn();
        const { line } = handle({ onReset });
        fireEvent.doubleClick(line);
        expect(onReset).toHaveBeenCalledTimes(1);
    });
});
