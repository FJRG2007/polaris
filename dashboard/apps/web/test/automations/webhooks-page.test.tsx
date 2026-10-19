// @vitest-environment jsdom

/**
 * The Webhooks screen in Automations: the empty state, adding an endpoint (held
 * until the form is complete, the secret shown once afterwards), removing one
 * only through a dialog, the delivery log, the headers and sign-in dialog (a
 * stored secret shown as set, never sent back), and the deploy hooks card in a
 * service's settings.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundHookView } from "@/lib/notifications/outbound-hooks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const create = vi.fn(async (_input: unknown) => ({
    secret: "whsec_fixture",
    hook: undefined as unknown
}));
const remove = vi.fn(async (_id: unknown) => ({}));
const list = vi.fn(async (_id: unknown, _cursor: unknown) => ({
    page: {
        items: [
            {
                id: "00000000-0000-7000-8000-000000000002",
                event: "deploy.failed",
                status: "failed" as const,
                attempts: 6,
                nextAttemptAt: null,
                responseStatus: 500,
                error: "http" as const,
                durationMs: 120,
                createdAt: "2026-10-15T00:00:00.000Z"
            }
        ],
        nextCursor: null
    }
}));
const redeliver = vi.fn(async (_id: unknown) => ({
    status: "sent" as const,
    delivery: {
        id: "00000000-0000-7000-8000-000000000003",
        event: "deploy.failed",
        status: "sent" as const,
        attempts: 1,
        nextAttemptAt: null,
        responseStatus: 200,
        error: null,
        durationMs: 80,
        createdAt: "2026-10-15T00:01:00.000Z"
    }
}));

const saveRequest = vi.fn(async (_id: unknown, _input: unknown) => ({}));
vi.mock("@/app/(app)/automations/webhooks/actions", () => ({
    setOutboundHookRequestAction: (id: unknown, input: unknown) => saveRequest(id, input),
    createOutboundHookAction: (input: unknown) => create(input),
    deleteOutboundHookAction: (id: unknown) => remove(id),
    listOutboundDeliveriesAction: (id: unknown, cursor: unknown) => list(id, cursor),
    redeliverOutboundAction: (id: unknown) => redeliver(id),
    setOutboundHookEnabledAction: async () => ({}),
    setOutboundHookEventsAction: async () => ({}),
    rotateOutboundHookSecretAction: async () => ({ secret: "whsec_new" }),
    testOutboundHookAction: async () => ({ status: "sent" })
}));

const DEPLOY_HOOK = {
    id: "00000000-0000-7000-8000-0000000000aa",
    name: "CI on main",
    applicationId: "00000000-0000-7000-8000-0000000000bb",
    serviceName: "web",
    enabled: true,
    lastUsedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z"
};
const listDeployHooks = vi.fn(async (_id: unknown) => ({
    hooks: [DEPLOY_HOOK],
    baseUrl: "https://polaris.example.test"
}));
const rotateDeployHook = vi.fn(async (_id: unknown) => ({ secret: "whsec_rotated" }));
vi.mock("@/app/(app)/apps/deploy/deploy-hook-actions", () => ({
    listDeployHooksAction: (id: unknown) => listDeployHooks(id),
    rotateDeployHookSecretAction: (id: unknown) => rotateDeployHook(id),
    createDeployHookAction: async () => ({}),
    setDeployHookEnabledAction: async () => ({}),
    deleteDeployHookAction: async () => ({})
}));

const { WebhooksView } = await import("@/app/(app)/automations/webhooks/webhooks-view");
const { DeployHooksCard } = await import("@/app/(app)/apps/deploy/deploy-hooks-card");

const EVENTS = [
    { id: "deploy.failed", label: "Deploy failed", group: "Deploy" },
    { id: "deploy.succeeded", label: "Deploy succeeded", group: "Deploy" }
];

const HOOK: OutboundHookView = {
    id: "00000000-0000-7000-8000-000000000001",
    name: "Ops bot",
    urlHint: "hooks.example.test/in/...",
    events: ["deploy.failed"],
    request: { auth: { type: "none" }, headers: [] },
    enabled: true,
    consecutiveFailures: 0,
    disabledReason: null,
    lastDeliveryAt: null,
    createdAt: "2026-10-01T00:00:00.000Z"
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("the webhooks page", () => {
    it("says there is nothing yet", () => {
        render(<WebhooksView hooks={[]} events={EVENTS} />, { wrapper: MessagesWrapper });
        expect(screen.getByText(/No endpoints yet/)).toBeTruthy();
    });

    it("holds Add until the form is complete, then shows the secret once", async () => {
        render(<WebhooksView hooks={[]} events={EVENTS} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
        const buttons = screen.getAllByRole("button", { name: "Add endpoint" });
        const submit = buttons[buttons.length - 1] as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText("Deploy bot"), { target: { value: "Ops" } });
        fireEvent.change(screen.getByPlaceholderText("https://example.com/hooks/polaris"), {
            target: { value: "https://hooks.example.test/in" }
        });
        fireEvent.click(screen.getByLabelText("Deploy failed"));
        expect(submit.disabled).toBe(false);
        fireEvent.click(submit);
        await waitFor(() =>
            expect(create).toHaveBeenCalledWith({
                name: "Ops",
                url: "https://hooks.example.test/in",
                events: ["deploy.failed"]
            })
        );
        expect(await screen.findByText("whsec_fixture")).toBeTruthy();
    });

    it("removes an endpoint only after the dialog is confirmed", async () => {
        render(<WebhooksView hooks={[HOOK]} events={EVENTS} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Remove endpoint" }));
        expect(remove).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
        await waitFor(() => expect(remove).toHaveBeenCalledWith(HOOK.id));
    });

    it("loads the log, says why a delivery failed, and sends it again", async () => {
        render(<WebhooksView hooks={[HOOK]} events={EVENTS} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Delivery log" }));
        expect(await screen.findByText("It answered 500.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));
        await waitFor(() =>
            expect(redeliver).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000002")
        );
        expect(await screen.findByText("Sent again.")).toBeTruthy();
    });
});

describe("headers and sign-in", () => {
    const SIGNED: OutboundHookView = {
        ...HOOK,
        request: {
            auth: { type: "bearer", tokenSet: true },
            headers: [{ name: "X-Api-Key", secret: true, value: null, set: true }]
        }
    };

    it("shows a stored secret as set, and keeps it when the form leaves it alone", async () => {
        render(<WebhooksView hooks={[SIGNED]} events={EVENTS} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Headers and sign-in" }));
        expect(screen.getAllByText("Set and hidden")).toHaveLength(2);
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        // Nothing changed yet: nothing to save.
        expect(save.disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Add header" }));
        fireEvent.change(screen.getAllByPlaceholderText("Header name").at(-1)!, {
            target: { value: "X-Team" }
        });
        fireEvent.change(screen.getAllByPlaceholderText("Value").at(-1)!, {
            target: { value: "ops" }
        });
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await waitFor(() => expect(saveRequest).toHaveBeenCalledTimes(1));
        expect(saveRequest.mock.calls[0]![1]).toEqual({
            auth: { type: "bearer" },
            headers: [
                { name: "X-Api-Key", secret: true },
                { name: "X-Team", secret: false, value: "ops" }
            ]
        });
    });

    it("refuses a reserved or malformed header name before anything is sent", () => {
        render(<WebhooksView hooks={[HOOK]} events={EVENTS} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Headers and sign-in" }));
        fireEvent.click(screen.getByRole("button", { name: "Add header" }));
        fireEvent.change(screen.getByPlaceholderText("Header name"), {
            target: { value: "X-Polaris-Signature" }
        });
        fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "forged" } });
        expect(screen.getByText("Polaris sets this header itself.")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
            true
        );
        fireEvent.change(screen.getByPlaceholderText("Header name"), {
            target: { value: "Bad Name" }
        });
        expect(screen.getByText(/Letters, digits and/)).toBeTruthy();
    });
});

describe("deploy hooks in a service's settings", () => {
    it("lists the service's hooks after the card has drawn", async () => {
        render(<DeployHooksCard applicationId={DEPLOY_HOOK.applicationId} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Deploy hooks")).toBeTruthy();
        expect(await screen.findByText("CI on main")).toBeTruthy();
        expect(listDeployHooks).toHaveBeenCalledWith(DEPLOY_HOOK.applicationId);
    });

    it("makes a new secret only after the dialog is confirmed, and shows it once", async () => {
        render(<DeployHooksCard applicationId={DEPLOY_HOOK.applicationId} />, {
            wrapper: MessagesWrapper
        });
        await screen.findByText("CI on main");
        fireEvent.click(screen.getByRole("button", { name: "New signing secret" }));
        expect(rotateDeployHook).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Make new secret" }));
        expect(await screen.findByText("whsec_rotated")).toBeTruthy();
        expect(rotateDeployHook).toHaveBeenCalledWith(DEPLOY_HOOK.id);
    });
});
