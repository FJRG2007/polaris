/**
 * Where a session is renewed, and where it must not be.
 *
 * A renewal moves the expiry in the database and hands the browser a new cookie
 * in the same response. Read from a page or an action, that response is never
 * sent: the database moved, the cookie did not, and the cookie ran out a week
 * after signing in - in the middle of a call, once. So the server reads without
 * renewing, and the browser asks better-auth's own endpoint on a timer.
 */

import { describe, expect, it, vi } from "vitest";

const getSession = vi.fn(async () => null);
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-guard", () => ({ guardSession: vi.fn() }));
vi.mock("@polaris/auth", () => ({ canAny: vi.fn(), userHasPermission: vi.fn() }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: vi.fn() }));
vi.mock("@/lib/app-access", () => ({ homePathFor: vi.fn() }));
vi.mock("@/lib/view-as-service", () => ({ resolveViewAs: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));

const session = await import("../../src/lib/session");
const { dueForRenewal, RENEW_GAP_MS } = await import("../../src/components/session-keeper");

describe("reading the session on the server", () => {
    it("never renews it, since the new cookie would have nowhere to go", async () => {
        await session.getSession();
        expect(getSession).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.objectContaining({ disableRefresh: true }) })
        );
    });
});

describe("renewing from the browser", () => {
    it("asks straight away on a fresh screen", () => {
        expect(dueForRenewal(null, 1_000)).toBe(true);
    });

    it("does not ask twice in a few minutes, however often the tab is focused", () => {
        expect(dueForRenewal(1_000, 1_000 + RENEW_GAP_MS - 1)).toBe(false);
        expect(dueForRenewal(1_000, 1_000 + RENEW_GAP_MS)).toBe(true);
    });
});
