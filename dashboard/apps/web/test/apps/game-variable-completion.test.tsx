// @vitest-environment jsdom

/**
 * The variables offered as they are typed, the way a code editor completes a
 * name: `{` opens the list, `{call.` narrows it, and choosing one writes the
 * rest of it and its closing brace.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FormattedTextField } from "@polaris-app/game-servers/src/components/formatted-text-field";
import {
    acceptCompletion,
    completionSpot,
    completionsFor
} from "@polaris-app/game-servers/src/lib/minecraft/completion";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => "en-US" } }
}));

afterEach(cleanup);

const OPTIONS = [
    { label: "Players online", text: "{server.online}", title: "" },
    { label: "Player slots", text: "{server.max}", title: "" },
    { label: "People in the group's call", text: "{call.count}", title: "" },
    { label: "People in the group", text: "{call.max}", title: "" },
    { label: "Who is in the group's call", text: "{call.members}", title: "" }
];

describe("where a variable is being typed", () => {
    it("is right after an open brace and the start of a name", () => {
        expect(completionSpot("In call: {", 10)).toEqual({ from: 9, query: "" });
        expect(completionSpot("In call: {call.", 15)).toEqual({ from: 9, query: "call." });
        expect(completionSpot("{Call.Co", 8)).toEqual({ from: 0, query: "call.co" });
    });

    it("is nowhere in plain text, a closed variable or a fallback", () => {
        expect(completionSpot("In call", 7)).toBeNull();
        expect(completionSpot("{call.count} of", 15)).toBeNull();
        expect(completionSpot('{call.members | "no', 19)).toBeNull();
    });
});

describe("what is offered", () => {
    it("is everything for a bare brace", () => {
        expect(completionsFor("", OPTIONS)).toEqual(OPTIONS);
    });

    it("narrows to the names that start with what was typed, then the rest that match", () => {
        expect(completionsFor("call.", OPTIONS).map((one) => one.text)).toEqual([
            "{call.count}",
            "{call.max}",
            "{call.members}"
        ]);
        // "max" starts no name, but is in two of them.
        expect(completionsFor("max", OPTIONS).map((one) => one.text)).toEqual(["{server.max}", "{call.max}"]);
        expect(completionsFor("slots", OPTIONS).map((one) => one.text)).toEqual(["{server.max}"]);
    });
});

describe("choosing one", () => {
    it("writes the rest of the name and the brace, and puts the caret after it", () => {
        const text = "In call: {call.";
        const spot = completionSpot(text, text.length)!;
        expect(acceptCompletion(text, text.length, spot, OPTIONS[2]!)).toEqual({
            text: "In call: {call.count}",
            caret: 21
        });
    });

    it("uses a closing brace already there instead of doubling it", () => {
        const spot = completionSpot("{ca}/5", 3)!;
        expect(acceptCompletion("{ca}/5", 3, spot, OPTIONS[3]!)).toEqual({ text: "{call.max}/5", caret: 10 });
    });
});

function Field() {
    const [value, setValue] = useState("");
    return (
        <>
            <FormattedTextField value={value} onChange={setValue} rows={1} singleLine label="Line" inserts={OPTIONS} />
            <output data-testid="value">{value}</output>
        </>
    );
}

/** Type into the field as a person does: the text and where the caret ends up. */
function type(text: string) {
    const field = screen.getByRole("combobox", { name: "Line" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
    return field;
}

describe("the field", () => {
    it("opens the list on a brace and narrows it as the name is typed", () => {
        render(<Field />);
        type("In call: {");
        expect(screen.getAllByRole("option")).toHaveLength(OPTIONS.length);
        type("In call: {call.m");
        expect(screen.getAllByRole("option").map((one) => one.textContent)).toEqual([
            "{call.max}People in the group",
            "{call.members}Who is in the group's call"
        ]);
    });

    it("takes the highlighted one with Enter, after moving down to it", () => {
        render(<Field />);
        const field = type("In call: {call.");
        fireEvent.keyDown(field, { key: "ArrowDown" });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(screen.getByTestId("value").textContent).toBe("In call: {call.max}");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("goes away with Escape, and comes back with Ctrl+Space", () => {
        render(<Field />);
        const field = type("{");
        fireEvent.keyDown(field, { key: "Escape" });
        expect(screen.queryByRole("listbox")).toBeNull();
        fireEvent.keyDown(field, { key: " ", ctrlKey: true });
        expect(screen.getByRole("listbox")).toBeTruthy();
    });

    it("takes one from a press on it", () => {
        render(<Field />);
        type("{serv");
        fireEvent.mouseDown(screen.getByRole("option", { name: /Player slots/ }));
        expect(screen.getByTestId("value").textContent).toBe("{server.max}");
    });
});
