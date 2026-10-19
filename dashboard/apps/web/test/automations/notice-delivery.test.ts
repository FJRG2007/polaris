/**
 * What a "tell somebody" step reports. It is only `sent` when a channel took
 * the message: a bell row written already read, or a channel that refused,
 * is listed under `missed`, and with nothing delivered the step fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => ({
    notify: vi.fn(async () => ({
        inapp: "sent" as string,
        handedOff: undefined as string[] | undefined
    })),
    emailNotice: vi.fn(async () => ({ status: "sent", detail: null as string | null })),
    deliverToDestination: vi.fn(async () => ({ status: "sent", detail: null as string | null }))
}));
const mail = vi.hoisted(() => ({ channelId: null as string | null }));

vi.mock("@/lib/notifications/dispatch", () => dispatch);
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: async () => mail }));

const { deliverAutomationNotice } = await import("../../src/lib/automations/notice");
const { StepError } = await import("../../src/lib/automations/types");

const BASE = {
    userId: "user-1",
    event: "places.automation",
    title: "Automation: Studio Door",
    body: "Battery low",
    href: "/automations/a1",
    metadata: {}
};
const DESTINATION = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    dispatch.notify.mockClear();
    dispatch.notify.mockImplementation(async () => ({ inapp: "sent" }));
    dispatch.emailNotice.mockClear();
    dispatch.deliverToDestination.mockClear();
    mail.channelId = null;
});

describe("an automation notice", () => {
    it("keeps the account's rule for a step saved before there was a choice", async () => {
        const result = await deliverAutomationNotice(BASE);
        expect(result).toEqual({ sent: true, delivered: ["bell"], missed: [] });
        expect(dispatch.notify).toHaveBeenCalledWith(expect.objectContaining({ bellOnly: false }));
    });

    it("counts the rule's own channels for a step saved before there was a choice", async () => {
        dispatch.notify.mockImplementation(async () => ({ inapp: "off", handedOff: ["email"] }));
        const result = await deliverAutomationNotice(BASE);
        expect(result).toEqual({
            sent: true,
            delivered: ["email"],
            missed: [{ channel: "bell", reason: "bell.off" }]
        });
    });

    it("fails instead of reporting sent when the bell row was written already read", async () => {
        dispatch.notify.mockImplementation(async () => ({ inapp: "read" }));
        const failure = await deliverAutomationNotice(BASE).catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(StepError);
        expect((failure as InstanceType<typeof StepError>).code).toBe("noticeNotDelivered");
        expect((failure as InstanceType<typeof StepError>).output).toEqual({
            sent: false,
            missed: [{ channel: "bell", reason: "bell.read" }]
        });
    });

    it("delivers only where the step says, and lists what missed", async () => {
        const result = await deliverAutomationNotice({
            ...BASE,
            delivery: { bell: false, email: true, destinations: [DESTINATION], chat: null }
        });
        expect(dispatch.notify).not.toHaveBeenCalled();
        // No outbound mail channel: email is a miss, never attempted.
        expect(dispatch.emailNotice).not.toHaveBeenCalled();
        expect(result.delivered).toEqual(["destination"]);
        expect(result.missed).toEqual([{ channel: "email", reason: "noMailChannel" }]);
    });

    it("sends email when this Polaris has a mail channel", async () => {
        mail.channelId = "mail-1";
        const result = await deliverAutomationNotice({
            ...BASE,
            delivery: { bell: true, email: true, destinations: [], chat: null }
        });
        expect(dispatch.notify).toHaveBeenCalledWith(expect.objectContaining({ bellOnly: true }));
        expect(result.delivered.sort()).toEqual(["bell", "email"]);
    });

    it("counts a channel that throws as a miss on that channel", async () => {
        dispatch.deliverToDestination.mockImplementationOnce(async () => {
            throw new Error("boom");
        });
        const result = await deliverAutomationNotice({
            ...BASE,
            delivery: { bell: true, email: false, destinations: [DESTINATION], chat: null }
        });
        expect(result.delivered).toEqual(["bell"]);
        expect(result.missed).toEqual([{ channel: "destination", reason: "failed" }]);
    });
});
