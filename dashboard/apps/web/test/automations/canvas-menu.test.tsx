// @vitest-environment jsdom

/**
 * The right-click menus of the automation canvas: the empty canvas, a node, a
 * connection and a selection of several. Each item shows its key, and the item
 * does what that key does.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({ rotateHookAction: vi.fn() }));

import * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import type { AutomationDetail } from "@/lib/automations/service";
import { CanvasEditor } from "@/app/(app)/automations/[id]/canvas-editor";

const TRIGGER = "11111111-1111-4111-8111-111111111111";
const STEP = "22222222-2222-4222-8222-222222222222";

function twoNodes(): core.AutomationGraph {
    const graph = core.emptyGraph("UTC");
    const withNodes: core.AutomationGraph = {
        ...graph,
        nodes: [
            { id: TRIGGER, type: "core.manual", config: {}, position: { x: 0, y: 0 } },
            {
                id: STEP,
                type: "core.notify",
                config: { title: "Hello", body: "" },
                position: { x: 320, y: 0 }
            }
        ] as core.GraphNode[]
    };
    return core.connect(withNodes, { node: TRIGGER, port: "next" }, STEP);
}

let latest: core.AutomationGraph = core.emptyGraph("UTC");

function Harness({ start, readOnly = false }: { start: core.AutomationGraph; readOnly?: boolean }) {
    const [graph, setGraph] = useState(start);
    latest = graph;
    return (
        <CanvasEditor
            graph={graph}
            change={(update) => setGraph((current) => update(current))}
            undo={() => undefined}
            redo={() => undefined}
            readOnly={readOnly}
            detail={{ canEdit: !readOnly, draft: graph } as unknown as AutomationDetail}
            secrets={[]}
            samples={{}}
            onChanged={() => undefined}
        />
    );
}

const board = () => screen.getByRole("application");
const menu = async () => within(await screen.findByRole("menu"));

afterEach(cleanup);

describe("the canvas right-click menus", () => {
    it("offers adding, pasting, undo, selecting and the view on the empty canvas, each with its key", async () => {
        render(<Harness start={twoNodes()} />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(board(), { clientX: 40, clientY: 40 });
        const items = await menu();
        for (const [label, key] of [
            ["Add node", "N"],
            ["Add note", "Shift+S"],
            ["Paste", "Ctrl+V"],
            ["Undo last change", "Ctrl+Z"],
            ["Select all", "Ctrl+A"],
            ["Tidy up", "Shift+Alt+T"],
            ["Fit to view", "1"]
        ]) {
            const item = items.getByRole("menuitem", { name: new RegExp(`^${label}`) });
            expect(item.textContent?.replace(/\s/g, "")).toContain(key!.replace(/\s/g, ""));
        }
    });

    it("adds a note where it was opened", async () => {
        render(<Harness start={twoNodes()} />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(board(), { clientX: 40, clientY: 40 });
        fireEvent.click((await menu()).getByRole("menuitem", { name: /^Add note/ }));
        expect(latest.notes).toHaveLength(1);
    });

    it("deletes a connection from its own menu", async () => {
        const { container } = render(<Harness start={twoNodes()} />, { wrapper: MessagesWrapper });
        const edge = container.querySelector("[data-edge-key]")!;
        fireEvent.contextMenu(edge);
        fireEvent.click((await menu()).getByRole("menuitem", { name: /^Delete connection/ }));
        expect(latest.edges).toHaveLength(0);
        expect(latest.nodes).toHaveLength(2);
    });

    it("shows only what acts on all of them when several are selected", async () => {
        render(<Harness start={twoNodes()} />, { wrapper: MessagesWrapper });
        fireEvent.keyDown(board(), { key: "a", ctrlKey: true });
        const node = document.querySelector(`[data-node-id="${STEP}"]`)!;
        fireEvent.contextMenu(node);
        const items = await menu();
        expect(items.getByRole("menuitem", { name: /^Delete 2 nodes/ })).toBeTruthy();
        expect(items.getByRole("menuitem", { name: /^Cut/ })).toBeTruthy();
        expect(items.queryByRole("menuitem", { name: /^Open settings/ })).toBeNull();
        expect(items.queryByRole("menuitem", { name: /^Rename/ })).toBeNull();
        fireEvent.click(items.getByRole("menuitem", { name: /^Duplicate/ }));
        expect(latest.nodes).toHaveLength(4);
    });

    it("keeps a single node's own items, and its key works the same", async () => {
        render(<Harness start={twoNodes()} />, { wrapper: MessagesWrapper });
        const node = document.querySelector(`[data-node-id="${STEP}"]`)!;
        fireEvent.contextMenu(node);
        const items = await menu();
        expect(items.getByRole("menuitem", { name: /^Open settings/ })).toBeTruthy();
        expect(items.getByRole("menuitem", { name: /^Switch off/ }).textContent).toContain("D");
        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
        fireEvent.keyDown(board(), { key: "d" });
        expect(latest.nodes.find((entry) => entry.id === STEP)?.enabled).toBe(false);
    });

    it("offers nothing that would change a read-only automation", async () => {
        render(<Harness start={twoNodes()} readOnly />, { wrapper: MessagesWrapper });
        fireEvent.contextMenu(board(), { clientX: 40, clientY: 40 });
        const items = await menu();
        expect(items.queryByRole("menuitem", { name: /^Add node/ })).toBeNull();
        expect(items.queryByRole("menuitem", { name: /^Paste/ })).toBeNull();
        expect(items.getByRole("menuitem", { name: /^Fit to view/ })).toBeTruthy();
    });
});
