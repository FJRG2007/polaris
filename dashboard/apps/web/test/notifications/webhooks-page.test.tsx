// @vitest-environment jsdom

/**
 * The Webhooks page: the empty state, adding an endpoint (held until the form is
 * complete, the secret shown once afterwards), removing one only through a
 * dialog, and the delivery log - loading, its rows, and Redeliver.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundHookView } from "@/lib/notifications/outbound-hooks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const create = vi.fn(async (_input: unknown) => ({ secret: "whsec_fixture", hook: undefined as unknown }));
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

vi.mock("@/app/(app)/account/webhooks/actions", () => ({
    createOutboundHookAction: (input: unknown) => create(input),
    deleteOutboundHookAction: (id: unknown) => remove(id),
    listOutboundDeliveriesAction: (id: unknown, cursor: unknown) => list(id, cursor),
    redeliverOutboundAction: (id: unknown) => redeliver(id),
    setOutboundHookEnabledAction: async () => ({}),
    setOutboundHookEventsAction: async () => ({}),
    rotateOutboundHookSecretAction: async () => ({ secret: "whsec_new" }),
    testOutboundHookAction: async () => ({ status: "sent" }),
    createInboundHookAction: async () => ({}),
    setInboundHookEnabledAction: async () => ({}),
    deleteInboundHookAction: async () => ({})
}));

const { WebhooksView } = await import("@/app/(app)/account/webhooks/webhooks-view");
const { InboundHooksCard } = await import("@/app/(app)/account/webhooks/inbound-hooks-card");

const EVENTS = [
    { id: "deploy.failed", label: "Deploy failed", group: "Deploy" },
    { id: "deploy.succeeded", label: "Deploy succeeded", group: "Deploy" }
];

const HOOK: OutboundHookView = {
    id: "00000000-0000-7000-8000-000000000001",
    name: "Ops bot",
    urlHint: "hooks.example.test/in/...",
    events: ["deploy.failed"],
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
            expect(create).toHaveBeenCalledWith({ name: "Ops", url: "https://hooks.example.test/in", events: ["deploy.failed"] })
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
        await waitFor(() => expect(redeliver).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000002"));
        expect(await screen.findByText("Sent again.")).toBeTruthy();
    });
});

describe("deploy hooks", () => {
    it("offers nothing to add when no service can be redeployed", () => {
        render(<InboundHooksCard hooks={[]} services={[]} baseUrl="https://polaris.example.test" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText(/no services you can redeploy/)).toBeTruthy();
        expect((screen.getByRole("button", { name: "Add deploy hook" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("names the service a hook redeploys", () => {
        render(
            <InboundHooksCard
                hooks={[
                    {
                        id: "00000000-0000-7000-8000-0000000000aa",
                        name: "CI",
                        applicationId: "00000000-0000-7000-8000-0000000000bb",
                        serviceName: "api",
                        enabled: true,
                        lastUsedAt: null,
                        createdAt: "2026-10-01T00:00:00.000Z"
                    }
                ]}
                services={[{ id: "00000000-0000-7000-8000-0000000000bb", name: "api", project: "Shop" }]}
                baseUrl="https://polaris.example.test"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Redeploys api")).toBeTruthy();
    });
});
