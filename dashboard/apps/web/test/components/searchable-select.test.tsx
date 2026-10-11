// @vitest-environment jsdom

/**
 * The select every version in the game servers is picked with: a long list
 * that can be typed down to the entry somebody came for, and then chosen with
 * the keyboard as well as the pointer.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterSearchableOptions, SearchableSelect } from "@polaris/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

const RELEASES = ["1.21.4", "1.21.3", "1.20.6", "1.20.1", "1.19.4"].map((value) => ({
    value,
    label: value
}));

function Harness({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState("1.21.4");
    return (
        <SearchableSelect
            aria-label="Minecraft version"
            value={value}
            onValueChange={(next) => {
                setValue(next);
                onChange(next);
            }}
            options={[{ value: "LATEST", label: "Latest", keywords: "newest" }, ...RELEASES]}
            searchPlaceholder="Search versions"
            emptyText="No version matches that."
        />
    );
}

describe("filtering the options", () => {
    it("keeps every option for an empty search and matches anywhere in the label", () => {
        expect(filterSearchableOptions(RELEASES, "")).toHaveLength(5);
        expect(filterSearchableOptions(RELEASES, "20.").map((option) => option.value)).toEqual([
            "1.20.6",
            "1.20.1"
        ]);
    });

    it("matches the keywords an option carries besides its label", () => {
        const options = [{ value: "LATEST", label: "Latest", keywords: "newest" }];
        expect(filterSearchableOptions(options, "newest")).toHaveLength(1);
        expect(filterSearchableOptions(options, "oldest")).toHaveLength(0);
    });
});

describe("the select", () => {
    it("shows the chosen option and narrows the list as somebody types", async () => {
        const user = userEvent.setup();
        render(<Harness onChange={() => undefined} />);
        const trigger = screen.getByRole("button", { name: "Minecraft version" });
        expect(trigger.textContent).toContain("1.21.4");

        await user.click(trigger);
        const search = await screen.findByPlaceholderText("Search versions");
        await waitFor(() => expect(document.activeElement).toBe(search));
        expect(screen.getAllByRole("menuitem")).toHaveLength(6);

        await user.type(search, "1.20");
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
            "1.20.6",
            "1.20.1"
        ]);
    });

    it("says so when nothing matches", async () => {
        const user = userEvent.setup();
        render(<Harness onChange={() => undefined} />);
        await user.click(screen.getByRole("button", { name: "Minecraft version" }));
        await user.type(await screen.findByPlaceholderText("Search versions"), "9.9.9");
        expect(screen.getByText("No version matches that.")).toBeTruthy();
        expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    });

    it("picks the first match on enter, without the keyboard leaving the field", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Harness onChange={onChange} />);
        await user.click(screen.getByRole("button", { name: "Minecraft version" }));
        const search = await screen.findByPlaceholderText("Search versions");
        await waitFor(() => expect(document.activeElement).toBe(search));
        await user.type(search, "1.19{Enter}");
        expect(onChange).toHaveBeenCalledWith("1.19.4");
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Minecraft version" }).textContent).toContain(
                "1.19.4"
            )
        );
    });

    it("picks an option by pointer", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Harness onChange={onChange} />);
        await user.click(screen.getByRole("button", { name: "Minecraft version" }));
        await user.click(await screen.findByRole("menuitem", { name: "1.20.1" }));
        expect(onChange).toHaveBeenCalledWith("1.20.1");
    });
});
