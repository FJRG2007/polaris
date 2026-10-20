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
    listWorkflowRunsAction: async () => ({
        ok: true,
        runs: [
            {
                id: "r1",
                status: "failed",
                cause: "created",
                recordId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                error: "City: Enter a number.",
                startedAt: "2026-10-01T10:00:00.000Z",
                finishedAt: "2026-10-01T10:00:01.000Z",
                resumeAt: null
            },
            {
                id: "r2",
                status: "waiting",
                cause: "manual",
                recordId: null,
                error: null,
                startedAt: "2026-10-01T09:00:00.000Z",
                finishedAt: null,
                resumeAt: "2026-10-02T09:00:00.000Z"
            }
        ]
    }),
    listWorkflowVersionsAction: async () => ({
        ok: true,
        versions: [
            {
                id: "v2",
                name: "Welcome",
                trigger: { kind: "created" },
                actions: [],
                savedById: "u1",
                createdAt: "2026-10-02T10:00:00.000Z"
            },
            {
                id: "v1",
                name: "Welcome first",
                trigger: { kind: "created" },
                actions: [
                    {
                        kind: "ifElse",
                        when: { conjunction: "and", rules: [] },
                        then: [{ kind: "httpRequest", url: "https://example.invalid/hook" }],
                        otherwise: []
                    },
                    { kind: "delay", minutes: 120 }
                ],
                savedById: "u3",
                createdAt: "2026-10-01T10:00:00.000Z"
            }
        ]
    }),
    workflowOptionsAction: async () => ({
        ok: true,
        mail: true,
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
    // The layout the reader picks is remembered, where there is storage to
    // remember it in: each test starts on the sentence.
    window.localStorage?.removeItem("crm.workflows.layout");
});

afterEach(cleanup);

describe("the workflows dialog", () => {
    it("lists each workflow with its trigger, its runs and why it last failed", async () => {
        open();
        expect(await screen.findByText("Welcome")).toBeTruthy();
        expect(screen.getByText(/A record is created/)).toBeTruthy();
        expect(screen.getByText(/Ran 3 times/)).toBeTruthy();
        expect(screen.getByText("Last run failed: City: Enter a number.")).toBeTruthy();
        expect(screen.getByText("Failed")).toBeTruthy();
    });

    it("opens a workflow from its name as a sentence: when, if, then", async () => {
        state.rows = [
            {
                ...(state.rows[0] as object),
                actions: [
                    { kind: "filter", when: { conjunction: "and", rules: [] } },
                    { kind: "delay", minutes: 60 }
                ]
            }
        ];
        open();
        fireEvent.click(await screen.findByRole("button", { name: /^Welcome/ }));
        expect(await screen.findByText("Edit workflow")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "When" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "If" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Then" })).toBeTruthy();
        // The leading filter is the IF; removing it leaves the delay alone.
        fireEvent.click(screen.getByRole("button", { name: "Remove condition" }));
        expect(screen.getByRole("button", { name: "Add condition" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
        // Put back as it was, it has nothing to save.
        const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save().disabled).toBe(true);
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Welcome back" } });
        await act(async () => {
            fireEvent.click(save());
        });
        await waitFor(() => expect(state.saved).toHaveLength(1));
        expect(state.saved[0]).toMatchObject({
            workflow: { actions: [{ kind: "filter" }, { kind: "delay", minutes: 60 }] }
        });
    });

    it("previews the workflow as a diagram", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
        fireEvent.click(screen.getByRole("radio", { name: "Diagram" }));
        expect(screen.queryByRole("heading", { name: "If" })).toBeNull();
        expect(screen.getAllByText("A record is created").length).toBeGreaterThan(0);
    });

    it("switches one off at once, and back on when the server refuses", async () => {
        state.refuseToggle = true;
        open();
        const toggle = await screen.findByRole("switch", { name: "Turn off Welcome" });
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() =>
            expect(state.toggled).toEqual([{ object: "companies", id: FLOW, enabled: false }])
        );
        await waitFor(() =>
            expect(
                screen
                    .getByRole("switch", { name: "Turn off Welcome" })
                    .getAttribute("aria-checked")
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

    it("offers an email once the reader has a mailbox, and branches, loops and waits", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
        await act(async () => undefined);
        fireEvent.pointerDown(screen.getByRole("button", { name: "Add action" }), {
            button: 0,
            ctrlKey: false
        });
        for (const name of [
            "Send an email",
            "Go on only if the record matches",
            "If the record matches",
            "For each record found",
            "Wait"
        ]) {
            expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
        }
        fireEvent.click(screen.getByRole("menuitem", { name: "If the record matches" }));
        expect(await screen.findByText("When it does not")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Add action" })).toHaveLength(3);
    });

    it("shows a workflow's runs: how each ended, why, and the record", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "Runs" }));
        expect(await screen.findByText("Runs of Welcome")).toBeTruthy();
        expect(await screen.findByText("Failed")).toBeTruthy();
        expect(screen.getByText("Waiting")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Open record" })).toBeNull();
        fireEvent.click(screen.getByText("Failed").closest("button")!);
        expect(screen.getByText("City: Enter a number.")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open record" }).getAttribute("href")).toContain(
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        );
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByText("Welcome")).toBeTruthy();
    });

    it("shows a workflow's steps and saved versions, and edits from an older one", async () => {
        open();
        await screen.findByText("Welcome");
        fireEvent.click(screen.getByRole("button", { name: "Versions and steps" }));
        expect(await screen.findByText("Versions of Welcome")).toBeTruthy();
        expect(screen.getByText("How it runs now")).toBeTruthy();
        expect(await screen.findByText("Welcome first")).toBeTruthy();
        expect(screen.getByText(/by Other User/)).toBeTruthy();
        expect(screen.queryByText("If the record matches")).toBeNull();
        fireEvent.click(screen.getAllByRole("button", { name: "Show steps" })[1]!);
        expect(screen.getByText("If the record matches")).toBeTruthy();
        expect(screen.getByText("https://example.invalid/hook")).toBeTruthy();
        expect(screen.getByText("2 hours")).toBeTruthy();
        fireEvent.click(screen.getAllByRole("button", { name: "Edit from this version" })[1]!);
        expect(await screen.findByText("Edit workflow")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(state.saved).toHaveLength(1));
        expect(state.saved[0]).toMatchObject({
            workflow: {
                id: FLOW,
                name: "Welcome first",
                actions: [{ kind: "ifElse" }, { kind: "delay" }]
            }
        });
    });
});
