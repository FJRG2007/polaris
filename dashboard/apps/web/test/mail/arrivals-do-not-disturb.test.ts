/**
 * In do not disturb new mail raises no notice: the arrivals route still moves
 * the cursor, so what came in during a call is not announced once it ends,
 * and names nothing. A failed read of the status never mutes mail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let quiet: boolean | Error = false;

vi.mock("@/lib/api-session", () => ({ apiPermission: async () => ({ id: "ada" }) }));
vi.mock("@/lib/mailbox/arrivals", () => ({
    arrivalsSince: async (_user: string, since: Date | null) => ({
        cursor: "2026-10-21T10:00:00.000Z",
        named: since ? [{ threadId: "t1", from: "Grace", subject: "Hello" }] : [],
        more: since ? 3 : 0
    })
}));
vi.mock("@/lib/presence-service", () => ({
    doNotDisturbOf: async () => {
        if (quiet instanceof Error) throw quiet;
        return { on: quiet, reason: quiet ? "call" : null, until: null };
    }
}));

const { GET } = await import("@/app/api/mail/arrivals/route");

const ask = () =>
    GET(new Request("https://polaris.test/api/mail/arrivals?since=2026-10-21T09:00:00.000Z")).then(
        (response) => response.json()
    );

beforeEach(() => {
    quiet = false;
});

describe("mail arrivals in do not disturb", () => {
    it("names the new mail when nothing is holding it back", async () => {
        expect(await ask()).toMatchObject({ named: [{ threadId: "t1" }], more: 3 });
    });

    it("moves the cursor and names nothing while it is on", async () => {
        quiet = true;
        expect(await ask()).toEqual({ cursor: "2026-10-21T10:00:00.000Z", named: [], more: 0 });
    });

    it("still names the mail when the status could not be read", async () => {
        quiet = new Error("down");
        expect(await ask()).toMatchObject({ named: [{ threadId: "t1" }], more: 3 });
    });
});
