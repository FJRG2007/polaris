/**
 * The composer's endpoints: write a draft, send, Undo, Send now.
 *
 * They replaced server actions (see `sending-does-not-hold-the-router`), so they
 * are held to what those promised and a little more: everything is validated
 * before anything is written, only a body that says it is JSON is read - which
 * is what keeps another site from posting here - and somebody else's draft
 * answers exactly as one that is not there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let refuseAccess = false;

class MailAccessError extends Error {}

vi.mock("@/lib/api-session", () => ({
    apiPermission: async () => ({ id: "u1" })
}));
vi.mock("@/lib/mailbox/access", () => ({ MailAccessError }));
vi.mock("@/lib/mailbox/compose", () => ({
    saveDraft: async (_userId: string, input: { draftId: string | null }) => {
        calls.push(`save ${input.draftId ?? "new"}`);
        return DRAFT;
    },
    queueSend: async (_userId: string, input: { to: unknown[] }) => {
        calls.push(`queue ${input.to.length}`);
        return { draftId: DRAFT, sendAt: new Date("2026-09-19T10:00:10Z") };
    },
    cancelSend: async (_userId: string, draftId: string) => {
        if (refuseAccess) throw new MailAccessError("That draft is not yours.");
        calls.push(`undo ${draftId}`);
        return true;
    },
    sendNow: async (_userId: string, draftId: string) => {
        if (refuseAccess) throw new MailAccessError("That draft is not yours.");
        calls.push(`now ${draftId}`);
        return true;
    }
}));

const DRAFT = "0198f0aa-0000-7000-8000-000000000001";
const ACCOUNT = "0198f0aa-0000-7000-8000-0000000000aa";

const outbox = await import("@/app/api/mail/outbox/route");
const one = await import("@/app/api/mail/outbox/[draftId]/route");
const drafts = await import("@/app/api/mail/drafts/route");

function post(body: unknown, type = "application/json"): Request {
    return new Request("http://polaris.test/api/mail/outbox", {
        method: "POST",
        headers: { "content-type": type },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

const params = (draftId: string) => ({ params: Promise.resolve({ draftId }) });

beforeEach(() => {
    calls.length = 0;
    refuseAccess = false;
});

describe("sending", () => {
    it("queues a message and answers with when it goes", async () => {
        const response = await outbox.POST(
            post({ accountId: ACCOUNT, to: [{ name: "", address: "ana@example.com" }], subject: "Hi" })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ draftId: DRAFT, sendAt: "2026-09-19T10:00:10.000Z" });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(calls).toEqual(["queue 1"]);
    });

    it("refuses a message to nobody, in words, and writes nothing", async () => {
        const response = await outbox.POST(post({ accountId: ACCOUNT, to: [] }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Say who it goes to", field: "to" });
        expect(calls).toEqual([]);
    });

    it("reads nothing that does not say it is JSON", async () => {
        const body = JSON.stringify({ accountId: ACCOUNT, to: [{ name: "", address: "a@b.co" }] });
        const response = await outbox.POST(post(body, "text/plain"));
        expect(response.status).toBe(400);
        expect(calls).toEqual([]);
    });
});

describe("one queued message", () => {
    it("is taken back by Undo", async () => {
        const response = await one.DELETE(new Request("http://polaris.test"), params(DRAFT));
        expect(await response.json()).toEqual({ undone: true });
        expect(calls).toEqual([`undo ${DRAFT}`]);
    });

    it("is sent at once by Send now", async () => {
        const response = await one.POST(new Request("http://polaris.test"), params(DRAFT));
        expect(await response.json()).toEqual({ sent: true });
        expect(calls).toEqual([`now ${DRAFT}`]);
    });

    it("is not looked for when the address does not name a draft", async () => {
        for (const handler of [one.POST, one.DELETE]) {
            const response = await handler(new Request("http://polaris.test"), params("../x"));
            expect(response.status).toBe(404);
        }
        expect(calls).toEqual([]);
    });

    it("answers for somebody else's draft as for one that is gone", async () => {
        refuseAccess = true;
        const response = await one.POST(new Request("http://polaris.test"), params(DRAFT));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "That draft is not yours." });
    });
});

describe("writing the draft", () => {
    it("saves what was typed and answers with its id", async () => {
        const response = await drafts.POST(
            post({ id: DRAFT, accountId: ACCOUNT, subject: "Half written" })
        );
        expect(await response.json()).toEqual({ draftId: DRAFT });
        expect(calls).toEqual([`save ${DRAFT}`]);
    });

    it("refuses a draft with no mailbox to belong to", async () => {
        const response = await drafts.POST(post({ subject: "Nowhere" }));
        expect(response.status).toBe(400);
        expect(calls).toEqual([]);
    });
});
