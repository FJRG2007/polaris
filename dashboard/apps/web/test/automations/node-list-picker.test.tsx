// @vitest-environment jsdom

/**
 * The list view (what a phone shows) adds triggers and steps through the same
 * picker as the canvas, so app events and app steps are there too.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() })
}));

import type * as core from "@polaris/core";
import { MessagesWrapper } from "../setup/i18n";
import type { AutomationDetail } from "@/lib/automations/service";
import { NodeList } from "@/app/(app)/automations/[id]/automation-editor";

afterEach(cleanup);

const DETAIL = { appNodes: {}, eventApps: ["game-servers"] } as unknown as AutomationDetail;

function list(only: "triggers" | "steps") {
    const onChange = vi.fn<(steps: core.ListStep[]) => void>();
    const onAdded = vi.fn();
    render(
        <NodeList
            nodes={[]}
            onChange={onChange}
            only={only}
            addLabel={only === "triggers" ? "Add trigger" : "Add step"}
            onAdded={onAdded}
            detail={DETAIL}
            secrets={[]}
            readOnly={false}
            onChanged={vi.fn()}
        />,
        { wrapper: MessagesWrapper }
    );
    return { onChange, onAdded };
}

describe("the list view's add picker", () => {
    it("adds an app event as a trigger, with its event filled in", () => {
        const { onChange, onAdded } = list("triggers");
        fireEvent.click(screen.getByRole("button", { name: "Add trigger" }));
        expect(screen.queryByText("Logic")).toBeNull();
        fireEvent.change(screen.getByPlaceholderText("Search nodes"), {
            target: { value: "keeps crashing" }
        });
        fireEvent.click(screen.getByText("Game server keeps crashing"));
        const [steps] = onChange.mock.calls[0]!;
        expect(steps).toHaveLength(1);
        expect(steps[0]!.node).toMatchObject({
            type: "core.onEvent",
            config: { name: "game-server.crashed", outcomes: [] }
        });
        expect(onAdded).toHaveBeenCalledWith("core.onEvent");
    });

    it("offers app steps and no triggers among the steps", () => {
        const { onChange } = list("steps");
        fireEvent.click(screen.getByRole("button", { name: "Add step" }));
        expect(screen.queryByText("Basics")).toBeNull();
        fireEvent.change(screen.getByPlaceholderText("Search nodes"), {
            target: { value: "Game servers" }
        });
        const options = screen
            .getAllByRole("button")
            .filter((button) => button.hasAttribute("data-add-option"));
        expect(options.length).toBeGreaterThan(0);
        fireEvent.click(options[0]!);
        const [steps] = onChange.mock.calls[0]!;
        expect(steps[0]!.node.type.startsWith("game-servers.action.")).toBe(true);
    });

    it("hides the add button where the list cannot be changed", () => {
        render(
            <NodeList
                nodes={[]}
                onChange={vi.fn()}
                only="steps"
                addLabel="Add step"
                detail={DETAIL}
                secrets={[]}
                readOnly
                onChanged={vi.fn()}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
    });
});
