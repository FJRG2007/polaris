/**
 * Where the "Continue on phone" QR lands a phone. Signed in as the person who
 * made it: straight on that session in Polar, the same address its alerts
 * use. Signed out: the sign-in that waits on the PIN typed on the computer.
 * Another account, or a spent code: one answer, and no session named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    user: null as { id: string } | null,
    spent: null as string | null,
    open: true
}));

class Redirected extends Error {
    constructor(readonly to: string) {
        super(to);
    }
}

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("next/navigation", () => ({
    redirect: (to: string) => {
        throw new Redirected(to);
    }
}));
vi.mock("@/lib/session", () => ({ getSession: async () => (state.user ? { user: state.user } : null) }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/components/public-shell", () => ({ LinkUnavailable: () => null }));
vi.mock("@/app/continue/[code]/continue-sign-in", () => ({ ContinueSignIn: () => null }));
vi.mock("@/lib/agents/session-pairing", () => ({
    PAIRING_CODE: /^[A-Za-z0-9_-]{22}$/,
    readPairing: async () => (state.open ? { sessionId: "s" } : null),
    spendPairing: async () => state.spent
}));

const { default: ContinuePage } = await import("@/app/continue/[code]/page");
const { LinkUnavailable } = await import("@/components/public-shell");
const { ContinueSignIn } = await import("@/app/continue/[code]/continue-sign-in");

const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const SESSION = "0190a5f2-2222-7000-8000-0000000000cc";
const land = () => ContinuePage({ params: Promise.resolve({ code: CODE }) });

beforeEach(() => {
    state.user = null;
    state.spent = null;
    state.open = true;
});

describe("the Continue on phone link", () => {
    it("lands its owner's phone on the session in Polar", async () => {
        state.user = { id: "owner" };
        state.spent = SESSION;
        await expect(land()).rejects.toEqual(new Redirected(`/polar?session=${SESSION}`));
    });

    it("names no session to another account", async () => {
        state.user = { id: "someone-else" };
        const page = (await land()) as { type: unknown };
        expect(page.type).toBe(LinkUnavailable);
    });

    it("signs a signed-out phone in first, on the computer's PIN", async () => {
        const page = (await land()) as { type: unknown; props: { code: string } };
        expect(page.type).toBe(ContinueSignIn);
        expect(page.props.code).toBe(CODE);
    });

    it("turns away a spent or expired link before any sign-in", async () => {
        state.open = false;
        const page = (await land()) as { type: unknown };
        expect(page.type).toBe(LinkUnavailable);
    });
});
