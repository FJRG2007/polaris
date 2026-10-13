// @vitest-environment jsdom

/**
 * A kind of record's workflows: listed with how they last ran, switched on or
 * off where they stand (and back if the server refuses), and a new one saved
 * with what the editor holds.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const FLOW = "99999999-9999-4999-8999-999999999999";

const state = vi.hoisted(() => ({
    rows: [] as unknown[],
    saved: [] as unknown[],
    toggled: [] as unknown[],
    refuseToggle: false
}));

vi.mock("@polaris-app/crm/src/actions/workflows", () => ({
    listWorkflowsAction: async () => ({ ok: true, workflows: state.rows }),
    saveWorkflowAction: async (input: { workflow: unknown }) => {
        state.saved.push(input);
        return { ok: true, workflow: input.workflow };
    },
    setWorkflowEnabledAction: async (input: { enabled: boolean }) => {
        state.toggled.push(input);
        return state.refuseToggle
            ? { ok: false, error: "Your role cannot change companies here." }
            : { ok: true, enabled: input.enabled };
    },
    deleteWorkflowAction: vi.fn(),
    workflowOptionsAction: async () => ({
        ok: true,
        taskLists: [],
        people: [
            { id: "u1", name: "Test User" },
            { id: "u3", name: "Other User" }
        ]
    })
}));

import { WorkflowsDialog } from "@polaris-app/crm/src/screens/workflows-dialog";

const open = () =>
    render(
        <WorkflowsDialog
            object="companies"
            open
            onClose={() => undefined}
            confirm={async () => true}
        />,
        { wrapper: MessagesWrapper }
    );

beforeEach(() => {
    state.rows = [
        {
            id: FLOW,
            name: "Welcome",
            trigger: { kind: "created" },
            actions: [],
            enabled: true,
            runCount: 3,
            lastRunAt: null,
            lastError: "City: Enter a number."
        }
    ];
    state.saved = [];
    state.toggled = [];
    state.refuseToggle = false;
});

afterEach(cleanup);

describe("the workflows dialog", () => {
    it("lists each workflow with its trigger, its runs and why it last failed", async () => {
        open();
        expect(await screen.findByText("Welcome")).toBeTruthy();
        expect(screen.getByText(/A record is created/)).toBeTruthy();
        expect(screen.getByText(/Ran 3 times/)).toBeTruthy();
        expect(screen.getByText("Last run failed: City: Enter a number.")).toBeTruthy();
    });

    it("switches one off at once, and back on when the server refuses", async () => {
        state.refuseToggle = true;
        open();
        const toggle = await screen.findByRole("switch", { name: "Enabled" });
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() =>
            expect(state.toggled).toEqual([{ object: "companies", id: FLOW, enabled: false }])
        );
        await waitFor(() =>
            expect(
                screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")
            ).toBe("true")
        );
    });

    it("saves a new workflow only once it has a name", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Greet" } });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        await waitFor(() =>
            expect(state.saved).toEqual([
                {
                    object: "companies",
                    workflow: {
                        name: "Greet",
                        trigger: { kind: "created" },
                        actions: [],
                        enabled: true
                    }
                }
            ])
        );
    });

    it("sends a notification to the people ticked, and offers no task without a list", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tell" } });
        fireEvent.pointerDown(screen.getByRole("button", { name: "Add action" }), {
            button: 0,
            ctrlKey: false
        });
        expect(await screen.findByRole("menuitem", { name: "Send a notification" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Create a task" })).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Send a notification" }));
        fireEvent.click(await screen.findByLabelText("Other User"));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        await waitFor(() =>
            expect(state.saved).toEqual([
                {
                    object: "companies",
                    workflow: {
                        name: "Tell",
                        trigger: { kind: "created" },
                        actions: [{ kind: "notify", to: ["u3"], title: "{{name}}", body: "" }],
                        enabled: true
                    }
                }
            ])
        );
    });
});
