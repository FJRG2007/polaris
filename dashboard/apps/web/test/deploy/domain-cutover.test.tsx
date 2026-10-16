// @vitest-environment jsdom

/**
 * The dialog that moves a domain to another service: closed to somebody who may
 * not manage the project's domains, a skeleton only where the cutover is still being
 * read, and in every phase what is happening, what to do next, and the rollback.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { CutoverView } from "@/lib/deploy/dns-cutover";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainCutoverButton } from "@/app/(app)/apps/deploy/domain-cutover";
import type { CutoverReply } from "@/app/(app)/apps/deploy/dns-cutover-actions";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const DOMAIN = "0192f1e2-7b5c-7d3e-8f00-00000000000d";
const TARGET = "0192f1e2-7b5c-7d3e-8f00-0000000000a2";
const HOST = "shop.example.com";

const actions = vi.hoisted(() => ({
    cutoverPanelAction: vi.fn(async (_domainId: string): Promise<CutoverReply> => ({})),
    startCutoverAction: vi.fn(async (_input: unknown): Promise<CutoverReply> => ({})),
    switchCutoverAction: vi.fn(async (_domainId: string): Promise<CutoverReply> => ({})),
    rollbackCutoverAction: vi.fn(async (_domainId: string): Promise<CutoverReply> => ({}))
}));

vi.mock("@/app/(app)/apps/deploy/dns-cutover-actions", () => actions);

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const TARGETS = [{ id: TARGET, name: "shop-v2", environment: "production" }];

function view(overrides: Partial<CutoverView> = {}): CutoverView {
    return {
        id: "0192f1e2-7b5c-7d3e-8f00-0000000000c1",
        hostname: HOST,
        phase: "ready",
        mode: "cloudflare",
        failure: null,
        sourceName: "shop",
        targetName: "shop-v2",
        targetApplicationId: TARGET,
        newValue: "203.0.113.7",
        oldValues: ["198.51.100.4"],
        oldTtl: 3600,
        lowerUntil: null,
        switchedAt: null,
        finishedAt: null,
        checkedAt: "2026-10-16T12:00:00.000Z",
        preflight: {
            deployed: true,
            running: true,
            answers: "up",
            code: 200,
            newValue: "203.0.113.7",
            tls: "on-switch"
        },
        resolvers: [],
        targetStatus: null,
        canSwitch: true,
        canRollback: true,
        ...overrides
    };
}

// Each test opens a domain of its own, so the dialog's per-domain memory of the
// last answer never carries one test's state into the next.
let opened = 0;

async function open(cutover: CutoverView | null, canManage = true) {
    actions.cutoverPanelAction.mockResolvedValue({ panel: { cutover, targets: TARGETS } });
    const domainId = `${DOMAIN.slice(0, -2)}${String(opened++).padStart(2, "0")}`;
    render(
        <DomainCutoverButton
            domainId={domainId}
            hostname={HOST}
            canManage={canManage}
            onChanged={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
    const button = screen.getByRole("button", { name: `Move ${HOST} to another service` });
    if (!canManage) return { button, domainId };
    fireEvent.click(button);
    await waitFor(() => expect(actions.cutoverPanelAction).toHaveBeenCalled());
    return { button, domainId };
}

describe("moving a domain to another service", () => {
    it("is held shut, with the reason, for somebody who cannot manage domains", async () => {
        const { button } = await open(null, false);
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(button.getAttribute("title")).toContain("You cannot change this project's domains.");
        expect(actions.cutoverPanelAction).not.toHaveBeenCalled();
    });

    it("draws its heading at once and a skeleton only where the cutover is being read", async () => {
        let answer: (reply: CutoverReply) => void = () => undefined;
        actions.cutoverPanelAction.mockImplementationOnce(
            () => new Promise<CutoverReply>((resolve) => (answer = resolve))
        );
        render(
            <DomainCutoverButton
                domainId={DOMAIN}
                hostname={HOST}
                canManage
                onChanged={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: `Move ${HOST} to another service` }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(`Move ${HOST}`)).toBeTruthy();
        expect(dialog.querySelector("[aria-busy='true']")).not.toBeNull();
        answer({ panel: { cutover: null, targets: TARGETS } });
        await waitFor(() => expect(within(dialog).getByText("Check and start")).toBeTruthy());
        expect(dialog.querySelector("[aria-busy='true']")).toBeNull();
    });

    it("offers the services it may move to and waits for one to be chosen", async () => {
        await open(null);
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(within(dialog).getByRole("combobox", { name: "Move to" })).toBeTruthy()
        );
        expect(
            within(dialog).getByRole("button", { name: "Check and start" }).hasAttribute("disabled")
        ).toBe(true);
    });

    it("says what failed the pre-flight and what to do about it", async () => {
        await open(
            view({
                phase: "preflight-failed",
                failure: "target-not-running",
                canSwitch: false,
                canRollback: false,
                preflight: {
                    deployed: true,
                    running: false,
                    answers: "unknown",
                    code: null,
                    newValue: "203.0.113.7",
                    tls: "on-switch"
                }
            })
        );
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(
                within(dialog).getByText(
                    "shop-v2 is not running. Start or redeploy it, then try again."
                )
            ).toBeTruthy()
        );
        expect(within(dialog).getByText("Not started")).toBeTruthy();
        expect(within(dialog).getByText("Move it again")).toBeTruthy();
        expect(within(dialog).queryByRole("button", { name: "Roll back" })).toBeNull();
    });

    it("names the exact record to change by hand, and switches once it is changed", async () => {
        const { domainId } = await open(view({ mode: "manual" }));
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(within(dialog).getByText("203.0.113.7", { selector: "td *, td" })).toBeTruthy()
        );
        expect(
            within(dialog).getByText(/Lower the record's TTL to 60 seconds and wait 3600 seconds/)
        ).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "I changed the record" }));
        await waitFor(() => expect(actions.switchCutoverAction).toHaveBeenCalledWith(domainId));
    });

    it("shows how far the change has reached while switching, and rolls back on confirmation", async () => {
        const { domainId } = await open(
            view({
                phase: "propagating",
                canSwitch: false,
                switchedAt: "2026-10-16T12:00:00.000Z",
                resolvers: [
                    {
                        label: "Cloudflare",
                        status: "answered",
                        values: ["203.0.113.7"],
                        agrees: true
                    },
                    { label: "Google", status: "answered", values: ["203.0.113.7"], agrees: true },
                    { label: "Quad9", status: "answered", values: ["198.51.100.4"], agrees: false }
                ],
                targetStatus: { status: "up", code: 200 }
            })
        );
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(
                within(dialog).getByText("2 of 3 public resolvers see the new address")
            ).toBeTruthy()
        );
        expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("67");
        expect(within(dialog).getByText(`shop-v2 answers for ${HOST}.`)).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
        const confirm = await screen.findByText("Roll back this move?");
        const confirmDialog = confirm.closest("[role='dialog']") as HTMLElement;
        expect(actions.rollbackCutoverAction).not.toHaveBeenCalled();
        fireEvent.click(within(confirmDialog).getByRole("button", { name: "Roll back" }));
        await waitFor(() => expect(actions.rollbackCutoverAction).toHaveBeenCalledWith(domainId));
    });

    it("says the move is done, and that the TTL is back", async () => {
        await open(view({ phase: "done", canSwitch: false, canRollback: false }));
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(within(dialog).getByText(`${HOST} now points at shop-v2.`)).toBeTruthy()
        );
        expect(within(dialog).getByText("The TTL is back to 3600 seconds.")).toBeTruthy();
    });

    it("after a rollback by hand, names the record to put back", async () => {
        await open(
            view({
                phase: "rolled-back",
                mode: "manual",
                switchedAt: "2026-10-16T12:00:00.000Z",
                canSwitch: false,
                canRollback: false
            })
        );
        const dialog = await screen.findByRole("dialog");
        await waitFor(() =>
            expect(within(dialog).getByText(`${HOST} is back on shop.`)).toBeTruthy()
        );
        expect(within(dialog).getByText("198.51.100.4", { selector: "td *, td" })).toBeTruthy();
    });

    it("leaves a failed move open to a rollback, with the reason", async () => {
        await open(view({ phase: "failed", failure: "propagation-timeout", canSwitch: false }));
        const dialog = await screen.findByRole("dialog");
        await waitFor(() => expect(within(dialog).getByText(/After 48 hours/)).toBeTruthy());
        expect(within(dialog).getByRole("button", { name: "Roll back" })).toBeTruthy();
    });

    it("shows a refusal from the server in words", async () => {
        actions.cutoverPanelAction.mockResolvedValueOnce({
            error: "You cannot change this project's domains."
        });
        render(
            <DomainCutoverButton
                domainId={DOMAIN}
                hostname={HOST}
                canManage
                onChanged={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: `Move ${HOST} to another service` }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "You cannot change this project's domains."
        );
    });
});
