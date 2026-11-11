// @vitest-environment jsdom

/**
 * The automatic-review fields: a list that inherits says what it inherits and
 * offers to set it here; a list set here adds on Enter or a comma, skips
 * repeats, removes one entry by its button, and goes back to inheriting. The
 * output fields add rows of a name and instructions, and say when one is only
 * half filled.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import { ListField } from "@polaris/ui";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewFields } from "@/components/agents/review-fields";
import { ReviewOutputFields } from "@/components/agents/review-output-fields";
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

describe("ReviewOutputFields", () => {
    function Output() {
        const [value, setValue] = useState(core.INHERIT_REVIEW);
        return (
            <>
                <ReviewOutputFields value={value} inherited={core.DEFAULT_REVIEW} onChange={setValue} />
                <output data-testid="recipes">{JSON.stringify(value.recipes)}</output>
            </>
        );
    }

    it("takes recipes over, adds a row, and flags it until both halves are filled", () => {
        render(<Output />, { wrapper: MessagesWrapper });
        // Your checks, leave out, path rules, recipes - in that order.
        fireEvent.click(screen.getAllByRole("button", { name: "Set here" })[3]!);
        expect(screen.getByTestId("recipes").textContent).toBe("[]");
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        fireEvent.change(screen.getByLabelText("Recipe name"), { target: { value: "add tests" } });
        expect(screen.getByText("Needs both fields to be saved.")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Write unit tests." } });
        expect(screen.queryByText("Needs both fields to be saved.")).toBeNull();
        expect(screen.getByTestId("recipes").textContent).toBe('[{"name":"add tests","instructions":"Write unit tests."}]');
        fireEvent.click(screen.getByRole("button", { name: "Remove add tests" }));
        expect(screen.getByTestId("recipes").textContent).toBe("[]");
    });
});
