// @vitest-environment jsdom

/**
 * The automation diagram, drawn by Polaris rather than by a diagram library.
 *
 * The report: the filters' visual editor carried a "React Flow" credit in its
 * corner, and the Deploy board zoomed only with Ctrl held. Both now answer the
 * same hand: the wheel zooms towards the pointer, dragging the board moves it,
 * and a node is still reordered by dragging it or by the arrow keys, and
 * removed with Delete.
 */

import { useState } from "react";
import type { FlowDefinition } from "../src/automation/graph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlowCanvas, type FlowCanvasLabels, type FlowVocabulary } from "../src/automation/canvas";


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
    actions: [
        { id: "step01", kind: "fixture" },
        { id: "step02", kind: "fixture" }
    ]
};

/** The steps' order as the editor holds it. */
let order: string[] = [];

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
            onChange={(change) =>
                setDefinition((current) => {
                    const next = change(current);
                    order = next.actions.map((step) => step.id);
                    return next;
                })
            }
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
    const found = document.querySelector<HTMLElement>(`[data-flow-node][data-id="${id}"]`);
    if (!found) throw new Error(`no node ${id} drawn`);
    return found;
}

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function layer(): HTMLElement {
    return node("trig01").parentElement!;
}

beforeEach(() => {
    order = [];
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
    }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the diagram", () => {
    it("carries no library's credit", () => {
        const { container } = render(<Editor />);
        expect(container.textContent).not.toMatch(/react flow/i);
        expect(container.querySelector(".react-flow__attribution")).toBeNull();
    });

    it("zooms on the wheel and moves when the board is dragged", () => {
        render(<Editor />);
        const frame = layer().parentElement!;
        const before = layer().style.transform;
        fireEvent(frame, new WheelEvent("wheel", { deltaY: -200, bubbles: true, cancelable: true }));
        expect(layer().style.transform).not.toBe(before);

        const zoomed = layer().style.transform;
        act(() => {
            frame.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }));
            window.dispatchEvent(new PointerEvent("pointermove", { clientX: 140, clientY: 130 }));
            window.dispatchEvent(new PointerEvent("pointerup", { clientX: 140, clientY: 130 }));
        });
        expect(layer().style.transform).not.toBe(zoomed);
    });

    it("reorders a step dragged below the next one", () => {
        render(<Editor />);
        const step = node("step01");
        act(() => {
            step.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
            window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 400 }));
            window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 400 }));
        });
        expect(order).toEqual(["step02", "step01"]);
    });

    it("moves a step with the arrow keys and removes it with Delete", () => {
        render(<Editor />);
        fireEvent.keyDown(node("step01"), { key: "ArrowDown" });
        expect(order).toEqual(["step02", "step01"]);
        fireEvent.keyDown(node("step01"), { key: "Delete" });
        expect(order).toEqual(["step02"]);
    });

    it("leaves a fixed trigger where it is", () => {
        render(<Editor />);
        fireEvent.keyDown(node("trig01"), { key: "Delete" });
        expect(node("trig01")).toBeTruthy();
    });
});
