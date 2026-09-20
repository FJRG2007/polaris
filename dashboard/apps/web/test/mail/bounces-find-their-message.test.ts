/**
 * Tying a delivery report back to the message it is about.
 *
 * The valuable half of this feature is the half that gives up. Marking a message
 * that arrived perfectly well as one that bounced is worse than never noticing a
 * bounce at all: the sender re-sends, apologises, or chases somebody who already
 * has their message. So a report that cannot be confidently named a message
 * settles nothing, and the send stays "accepted, nothing came back" - which is
 * true.
 *
 * The three cases pinned here are the three ways a report names its message: the
 * header the reporting server answered with, the copy of the original it carries,
 * and - when it has neither - the address it failed to. The last one is only
 * allowed when exactly one message is waiting on that address.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "0198f0aa-0000-7000-8000-00000000000a";

interface Send {
    id: string;
    messageId: string;
    subject: string;
    toJson: { name: string; address: string }[];
    state: string;
}

interface Arrival {
    id: string;
    threadId: string;
    subject: string;
    fromJson: { name: string; address: string }[];
    inReplyTo: string;
    references: string[];
    headers: Record<string, string> | null;
    bodyText: string | null;
}

const state = {
    sends: [] as Send[],
    arrivals: [] as Arrival[],
    settled: [] as { id: string; data: Record<string, unknown> }[],
    announced: [] as string[]
};

const BOUNCE_BODY = [
    "This is the mail system at host mail.example.net.",
    "",
    "Final-Recipient: rfc822; nobody@example.org",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550 5.1.1 Recipient address rejected: User unknown"
].join("\n");

function arrival(over: Partial<Arrival> = {}): Arrival {
    return {
        id: "m1",
        threadId: "t1",
        subject: "Undelivered Mail Returned to Sender",
        fromJson: [{ name: "", address: "MAILER-DAEMON@example.net" }],
        inReplyTo: "",
        references: [],
        headers: { "auto-submitted": "auto-replied" },
        bodyText: BOUNCE_BODY,
        ...over
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDelivery: {
            findMany: async ({ select }: { select?: Record<string, unknown> }) =>
                select && "accountId" in select ? [{ accountId: ACCOUNT }] : state.sends,
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; state: { in: string[] } };
                data: Record<string, unknown>;
            }) => {
                const send = state.sends.find((row) => row.id === where.id);
                if (!send || !where.state.in.includes(send.state)) return { count: 0 };
                send.state = String(data.state);
                state.settled.push({ id: send.id, data });
                return { count: 1 };
            }
        },
        mailMessage: { findMany: async () => state.arrivals }
    }
}));

vi.mock("@/lib/mailbox/delivery", () => ({
    announceBounce: async (_account: string, subject: string) => {
        state.announced.push(subject);
    },
    recipientsOf: (toJson: unknown) =>
        (toJson as { address: string }[]).map((entry) => entry.address.toLowerCase())
}));

const bounces = await import("@/lib/mailbox/bounces");

beforeEach(() => {
    state.sends = [
        {
            id: "d1",
            messageId: "sent-1@example.com",
            subject: "Invoice for March",
            toJson: [{ name: "", address: "nobody@example.org" }],
            state: "accepted"
        }
    ];
    state.arrivals = [];
    state.settled.length = 0;
    state.announced.length = 0;
});

describe("finding the message a report is about", () => {
    it("takes the id the reporting server answered with", async () => {
        state.arrivals = [arrival({ inReplyTo: "sent-1@example.com" })];
        expect(await bounces.sweepBounces()).toBe(1);
        expect(state.settled[0]?.data).toMatchObject({
            state: "bounced",
            detailFor: "nobody@example.org",
            reportThreadId: "t1"
        });
        expect(String(state.settled[0]?.data.detail)).toContain("User unknown");
    });

    it("reads the id out of the copy of the original the report carries", async () => {
        state.arrivals = [
            arrival({
                bodyText: `${BOUNCE_BODY}\n\n--- Original ---\nMessage-ID: <sent-1@example.com>\n`
            })
        ];
        expect(await bounces.sweepBounces()).toBe(1);
    });

    it("falls back to the address, when one message is waiting on it", async () => {
        state.arrivals = [arrival()];
        expect(await bounces.sweepBounces()).toBe(1);
        expect(state.announced).toEqual(["Invoice for March"]);
    });

    it("settles nothing when two messages are waiting on the same address", async () => {
        state.sends.push({
            id: "d2",
            messageId: "sent-2@example.com",
            subject: "The other one",
            toJson: [{ name: "", address: "nobody@example.org" }],
            state: "accepted"
        });
        state.arrivals = [arrival()];
        expect(await bounces.sweepBounces()).toBe(0);
        expect(state.announced).toHaveLength(0);
    });

    it("settles nothing for a report about a message this mailbox never sent", async () => {
        state.arrivals = [
            arrival({
                inReplyTo: "somebody-elses@example.net",
                bodyText: BOUNCE_BODY.replace("nobody@example.org", "stranger@example.net")
            })
        ];
        expect(await bounces.sweepBounces()).toBe(0);
    });
});

describe("what is not a bounce", () => {
    it("leaves an ordinary reply alone, however it is worded", async () => {
        state.arrivals = [
            arrival({
                subject: "Re: mail delivery failed?",
                fromJson: [{ name: "Ana", address: "ana@example.org" }],
                headers: {},
                bodyText: "Did your invoice bounce? Mine went through fine."
            })
        ];
        expect(await bounces.sweepBounces()).toBe(0);
        expect(state.announced).toHaveLength(0);
    });

    it("leaves a report with no body to read alone rather than guessing", async () => {
        state.arrivals = [arrival({ bodyText: null })];
        expect(await bounces.sweepBounces()).toBe(0);
    });
});

describe("saying it once", () => {
    it("does not tell anybody twice about the same message", async () => {
        state.arrivals = [arrival({ inReplyTo: "sent-1@example.com" })];
        await bounces.sweepBounces();
        // The row is `bounced` now, and the next pass reads the same message
        // again - the sweep has no cursor - so this is the guard that matters.
        expect(await bounces.sweepBounces()).toBe(0);
        expect(state.announced).toHaveLength(1);
    });

    it("lets a bounce overtake a delay, but never the other way round", async () => {
        state.arrivals = [
            arrival({
                inReplyTo: "sent-1@example.com",
                subject: "Delivery Status Notification (Delay)",
                bodyText: "Action: delayed\nStatus: 4.4.1\nFinal-Recipient: rfc822; nobody@example.org"
            })
        ];
        await bounces.sweepBounces();
        expect(state.sends[0]?.state).toBe("delayed");
        expect(state.announced).toHaveLength(0);

        state.arrivals = [arrival({ id: "m2", threadId: "t2", inReplyTo: "sent-1@example.com" })];
        expect(await bounces.sweepBounces()).toBe(1);
        expect(state.sends[0]?.state).toBe("bounced");
        expect(state.announced).toHaveLength(1);
    });
});
