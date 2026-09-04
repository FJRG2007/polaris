/**
 * An API route refusing, as an API refuses.
 *
 * The page guards redirect, which is right for a page and wrong under `/api`:
 * the Download button on a backup handed people a file called `login.htm`,
 * because the session had ended, the route redirected, and the browser followed
 * it and saved the sign-in page under the download's name. A `fetch` in the same
 * position parses HTML as JSON and reports something that has nothing to do with
 * what happened.
 *
 * So what is asserted here is the shape of a refusal: a status, never a
 * redirect, and no hint about which of the two reasons it was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const guardedUser = vi.fn<() => Promise<{ id: string; isAdmin: boolean } | null>>();
const sessionCan = vi.fn<() => Promise<boolean>>();

vi.mock("@/lib/session", () => ({ guardedUser, sessionCan }));

const { apiAdmin, apiPermission, apiUser } = await import("../../src/lib/api-session");

beforeEach(() => {
    vi.clearAllMocks();
    sessionCan.mockResolvedValue(true);
});

describe("nobody is signed in", () => {
    beforeEach(() => guardedUser.mockResolvedValue(null));

    it("answers 401 rather than sending the caller to a page", async () => {
        for (const guard of [apiUser(), apiAdmin(), apiPermission("deploy.read")]) {
            const answer = await guard;
            expect(answer).toBeInstanceOf(Response);
            expect((answer as Response).status).toBe(401);
            // A redirect is what turned a failed download into a saved login
            // page: whatever else changes here, this must not come back.
            expect((answer as Response).status).not.toBe(307);
        }
    });
});

describe("somebody is signed in", () => {
    it("hands the caller back when they may be here", async () => {
        guardedUser.mockResolvedValue({ id: "u1", isAdmin: true });
        expect(await apiUser()).toEqual({ id: "u1", isAdmin: true });
        expect(await apiAdmin()).toEqual({ id: "u1", isAdmin: true });
        expect(await apiPermission("deploy.read")).toEqual({ id: "u1", isAdmin: true });
    });

    it("answers 403 when they may not, which is a different thing from 401", async () => {
        guardedUser.mockResolvedValue({ id: "u1", isAdmin: false });
        sessionCan.mockResolvedValue(false);

        const asAdmin = (await apiAdmin()) as Response;
        expect(asAdmin.status).toBe(403);

        const byPermission = (await apiPermission("deploy.read")) as Response;
        expect(byPermission.status).toBe(403);
    });

    it("says nothing in the body that names what was asked for", async () => {
        guardedUser.mockResolvedValue({ id: "u1", isAdmin: false });
        sessionCan.mockResolvedValue(false);
        const refusal = (await apiPermission("deploy.manage")) as Response;
        const said = (await refusal.json()) as { error: string };
        expect(said.error).not.toContain("deploy.manage");
    });
});
