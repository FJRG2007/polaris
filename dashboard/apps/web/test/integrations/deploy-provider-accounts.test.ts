/**
 * Linking the accounts a service is run on somewhere else.
 *
 * Both of these are checked before anything is stored, so what the card shows is
 * the account the provider says the token belongs to. Two things about that are
 * worth holding in place.
 *
 * Railway answers GraphQL, which means a refused token arrives as a perfectly
 * successful HTTP response carrying "Not Authorized" in a list. Reading the
 * status alone would store a token that cannot do anything, under an account
 * nobody named.
 *
 * And the mistake somebody will actually make there is the token type: Railway
 * issues three, and only the account one can answer who it belongs to. That gets
 * its own sentence rather than the provider's, because "Not Authorized" does not
 * tell anybody which of the three they pasted.
 */

import { vercelUser, VercelError } from "@/lib/integrations/vercel-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railwayAccount, RailwayError } from "@/lib/integrations/railway-api";

let sent: { url: string; headers: Record<string, string>; body: string }[] = [];

function answers(status: number, payload: unknown): void {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({
            url: String(url),
            headers: (init.headers ?? {}) as Record<string, string>,
            body: typeof init.body === "string" ? init.body : ""
        });
        return new Response(JSON.stringify(payload), { status });
    });
}

beforeEach(() => {
    sent = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("a Vercel token", () => {
    it("is asked who it belongs to, with the token on the header and not in the path", async () => {
        answers(200, { user: { id: "u1", username: "jdoe", name: "J Doe", email: "j@example.com" } });
        const account = await vercelUser("vc_token");

        expect(account.username).toBe("jdoe");
        expect(sent[0]?.url).toBe("https://api.vercel.com/v2/user");
        expect(sent[0]?.headers.Authorization).toBe("Bearer vc_token");
    });

    it("is refused as a credential rather than as a failure", async () => {
        // The difference decides what happens next: a refused token has to be
        // said on the card, and a listing that fell over must leave everything
        // where it was.
        answers(401, { error: { message: "Not authorized" } });
        await expect(vercelUser("vc_bad")).rejects.toMatchObject({ kind: "unauthorized" });
    });

    it("passes their own sentence through rather than inventing one", async () => {
        answers(403, { error: { message: "You do not have access to this team" } });
        await expect(vercelUser("vc_bad")).rejects.toThrow(/do not have access to this team/);
    });

    it("says nothing about the token when their answer is not one it understands", async () => {
        answers(200, { nothing: true });
        const failure = await vercelUser("vc_token").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(VercelError);
        expect(String(failure)).not.toContain("vc_token");
    });
});

describe("a Railway token", () => {
    it("asks who it belongs to over their one endpoint", async () => {
        answers(200, { data: { me: { id: "r1", name: "Ada", email: "ada@example.com" } } });
        const account = await railwayAccount("rw_token");

        expect(account.name).toBe("Ada");
        expect(sent[0]?.url).toBe("https://backboard.railway.com/graphql/v2");
        expect(sent[0]?.headers.Authorization).toBe("Bearer rw_token");
        expect(sent[0]?.body).toContain("me");
    });

    it("reads a refusal that arrived as a successful response", async () => {
        // GraphQL answers 200 for almost everything. Trusting the status here
        // would store a token that can do nothing.
        answers(200, { errors: [{ message: "Not Authorized" }] });
        const failure = await railwayAccount("rw_project_token").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RailwayError);
        expect((failure as RailwayError).kind).toBe("unauthorized");
    });

    it("names the token type, which is the mistake somebody actually makes", async () => {
        answers(200, { errors: [{ message: "Not Authorized" }] });
        await expect(railwayAccount("rw_project_token")).rejects.toThrow(/account token/i);
    });

    it("passes any other complaint of theirs through as it was written", async () => {
        answers(200, { errors: [{ message: "Problem processing request" }] });
        await expect(railwayAccount("rw_token")).rejects.toThrow(/Problem processing request/);
    });
});
