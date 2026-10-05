// @vitest-environment jsdom

/**
 * A selected node stays selected while the window changes width.
 *
 * The report: with a node open, the window crossing the width at which the
 * diagram becomes a list and back - a resize, a rotated tablet, a full-page
 * screenshot - took the editor down with React's "Maximum update depth
 * exceeded". The diagram is drawn afresh when it comes back, and its own
 * selection, empty at that moment, was read back as the reader's: the two then
 * answered each other, one render apart, for ever. Places' automations and
 * Mail's filters share this canvas, so both went down.
 */

import { useState } from "react";
import type { FlowDefinition } from "../src/automation/graph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlowCanvas, type FlowCanvasLabels, type FlowVocabulary } from "../src/automation/canvas";

let wide = true;
const listeners = new Set<() => void>();

const LABELS: FlowCanvasLabels = {
    when: "When",
    if: "If",
    then: "Then",
    allGroups: "All groups hold",
    anyGroup: "Any group holds",
    allOf: "All of",
    anyOf: "Any of",
    addTrigger: "Add trigger",
    addCondition: "Add condition",
    addStep: "Add step",
    tooMany: "Too many",
    diagram: "Fixture diagram",
    add: "Add",
    toGroup: "Goes into the selected group",
    newGroup: "Starts a new group",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit",
    always: "Always",
    oneGroup: "This group holds",
    group: (number) => `Group ${number}`,
    unfinished: "Not finished",
    invalid: "Needs a fix",
    pick: "Select a node to change it.",
    inspector: "Selected node",
    close: "Close",
    reorderHint: "Drag to reorder",
    nodeHelp: "Press Enter to select",
    nodeHelpReadOnly: "Press Enter to select",
    moved: "Moved",
    handle: "Handle",
    edgeHelp: "Edge"
};

const kinds = {
    kinds: ["fixture"],
    kindText: () => "Fixture",
    blank: () => ({ id: "fixture-new", kind: "fixture" }),
    describe: (node: { id: string }) => `Fixture ${node.id}`
};

const VOCABULARY: FlowVocabulary<FlowDefinition> = {
    labels: LABELS,
    triggers: { ...kinds, fixed: true },
    conditions: kinds,
    steps: kinds,
    limits: { triggers: 4, groups: 4, conditionsPerGroup: 4, steps: 4 },
    newId: () => "fixture-group"
};

const DEFINITION: FlowDefinition = {
    triggers: [{ id: "trig01", kind: "fixture" }],
    conditions: {
        match: "all",
        groups: [{ id: "grp001", match: "all", items: [{ id: "cond01", kind: "fixture" }] }]
    },
    actions: [{ id: "step01", kind: "fixture" }]
};

/** The canvas the way an editor holds it: the draft in state, everything it
 *  hands down kept the same object across renders. */
function Editor() {
    const [definition, setDefinition] = useState(DEFINITION);
    const [stateOf] = useState(() => () => "ok" as const);
    return (
        <FlowCanvas
            definition={definition}
            vocabulary={VOCABULARY}
            readOnly={false}
            onChange={(change) => setDefinition(change)}
            stateOf={stateOf}
            renderInspector={(selection) => <p>Card for the {selection.role}</p>}
            stageIssues={[]}
        />
    );
}

class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

function node(id: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!found) throw new Error(`no node ${id} drawn`);
    return found;
}

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** The window crossing the width at which the diagram is drawn. */
async function resize(next: boolean): Promise<void> {
    wide = next;
    act(() => {
        for (const listener of listeners) listener();
    });
    await painted();
}

beforeEach(() => {
    wide = true;
    listeners.clear();
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("matchMedia", (query: string) => ({
        get matches() {
            return wide;
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
    }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("a selected node, as the window changes width", () => {
    it("keeps its card open through the list and back to the diagram", async () => {
        render(<Editor />);
        await painted();
        // The trigger is fixed in place, so a click selects it rather than
        // starting a drag.
        fireEvent.click(node("trig01"));
        await painted();
        expect(screen.getByText("Card for the trigger")).toBeDefined();

        await resize(false);
        expect(screen.getByText("Card for the trigger")).toBeDefined();

        await resize(true);
        expect(screen.getByRole("region", { name: "Fixture diagram" })).toBeDefined();
        expect(screen.getByText("Card for the trigger")).toBeDefined();
        expect(node("trig01").classList.contains("selected")).toBe(true);
    });

    it("lets go of the node when the reader closes its card", async () => {
        render(<Editor />);
        await painted();
        fireEvent.click(node("trig01"));
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await painted();
        expect(screen.getByText("Select a node to change it.")).toBeDefined();
        expect(node("trig01").classList.contains("selected")).toBe(false);
    });
});
