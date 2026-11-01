// @vitest-environment jsdom

/**
 * A list that grew: a thousand servers open as a search, draw a bounded number of
 * rows, and the one somebody types is still found.
 */

import { Select } from "@polaris/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const options = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ value: `id-${at}`, label: `server-${at}` }));

function open(): void {
    fireEvent.keyDown(screen.getByRole("button", { name: "Server" }), { key: "ArrowDown" });
}

afterEach(cleanup);

describe("Select with a long list", () => {
    it("searches, draws a limit, and finds what is past it", async () => {
        const chosen = vi.fn();
        render(
            <Select aria-label="Server" value="" onValueChange={chosen} options={options(1000)} />
        );
        open();
        const search = await screen.findByPlaceholderText("Search");
        expect(screen.getAllByRole("menuitem").length).toBe(200);
        expect(screen.getByText("800 more: keep typing to find them")).toBeTruthy();

        fireEvent.change(search, { target: { value: "server-999" } });
        fireEvent.click(await screen.findByText("server-999"));
        expect(chosen).toHaveBeenCalledWith("id-999");
    });

    it("stays a plain list when it is short", () => {
        render(<Select aria-label="Server" value="" onValueChange={vi.fn()} options={options(3)} />);
        expect(screen.getByRole("combobox")).toBeTruthy();
    });
});
