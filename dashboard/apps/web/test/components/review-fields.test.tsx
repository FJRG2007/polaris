// @vitest-environment jsdom

/**
 * The automatic-review fields: a list that inherits says what it inherits and
 * offers to set it here; a list set here adds on Enter or a comma, skips
 * repeats, removes one entry by its button, and goes back to inheriting.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { ListField } from "@/components/list-field";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewFields } from "@/components/agents/review-fields";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

function Harness({ initial }: { initial: core.ReviewSettings }) {
    const [value, setValue] = useState(initial);
    return (
        <>
            <ReviewFields
                value={value}
                inherited={{ ...core.DEFAULT_REVIEW, ignoreAuthors: ["dependabot[bot]"] }}
                onChange={setValue}
            />
            <output data-testid="value">{JSON.stringify(value.ignoreAuthors)}</output>
        </>
    );
}

describe("ListField", () => {
    function List() {
        const [value, setValue] = useState<string[]>([]);
        return (
            <>
                <ListField value={value} onChange={setValue} aria-label="Labels" caseInsensitive />
                <output data-testid="list">{JSON.stringify(value)}</output>
            </>
        );
    }

    it("adds on Enter and comma, skips repeats, removes by button", () => {
        render(<List />, { wrapper: MessagesWrapper });
        const input = screen.getByLabelText("Labels");
        fireEvent.change(input, { target: { value: "bug" } });
        fireEvent.keyDown(input, { key: "Enter" });
        fireEvent.change(input, { target: { value: "Bug, docs," } });
        expect(screen.getByTestId("list").textContent).toBe('["bug","docs"]');
        fireEvent.click(screen.getByRole("button", { name: "Remove bug" }));
        expect(screen.getByTestId("list").textContent).toBe('["docs"]');
    });
});

describe("ReviewFields", () => {
    it("shows an inherited list and lets this tier take it over and give it back", () => {
        render(<Harness initial={core.INHERIT_REVIEW} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Inherit (dependabot[bot])")).toBeTruthy();
        const overrides = screen.getAllByRole("button", { name: "Set here" });
        // Target branches, labels, title words, authors - in that order.
        fireEvent.click(overrides[3]!);
        expect(screen.getByTestId("value").textContent).toBe('["dependabot[bot]"]');
        fireEvent.click(screen.getByRole("button", { name: "Use inherited" }));
        expect(screen.getByTestId("value").textContent).toBe("null");
    });
});
