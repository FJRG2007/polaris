/**
 * What the sign-in screens do to somebody who is already signed in.
 *
 * They used to do nothing, which is the bug this covers: opening
 * `/oauth/login` with a live session drew the password form again. Nothing on
 * screen said the session was already there, nothing the person typed could
 * improve the situation, and the way out was to guess at an address by hand.
 *
 * The rule is the same on both screens and it is only about the ones whose whole
 * purpose is to establish a session. A reset link, an invite, a verification -
 * those are legitimately opened while signed in and are deliberately left alone.
 *
 * Order matters on the sign-in page and is asserted: a live challenge is the
 * more specific state, and somebody deliberately signing in as somebody else
 * belongs at the challenge rather than being turned around by the session they
 * are signing out of.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What `redirect` does in Next: it throws, so nothing after it runs. Thrown
 *  here too, or a page that redirected would carry on and render. */
class Redirected extends Error {
    constructor(readonly to: string) {
        super(`redirect:${to}`);
    }
}

let session: { id: string } | null = null;
let pendingChallenge: string | null = null;

vi.mock("next/navigation", () => ({
    redirect: (to: string) => {
        throw new Redirected(to);
    }
}));

vi.mock("@/lib/session", () => ({ resolveSession: async () => session }));
vi.mock("@/lib/two-factor-challenge", () => ({
    pendingTwoFactorUserId: async () => pendingChallenge
}));
vi.mock("@polaris/auth", () => ({ hasAnyUser: async () => true }));
vi.mock("@/lib/connections/oauth", () => ({ connectionSignInOffered: async () => false }));
vi.mock("@/lib/two-factor-delivery", () => ({
    challengeOptions: async () => ({
        methods: [{ method: "totp", target: null }],
        preferred: "totp"
    })
}));
// The screens themselves are not what is under test, and importing them pulls in
// the whole browser-side sign-in client.
vi.mock("@/app/oauth/login/login-form", () => ({ LoginForm: () => null }));
vi.mock("@/app/oauth/2fa/two-factor-view", () => ({ TwoFactorView: () => null }));

const { default: LoginPage } = await import("@/app/oauth/login/page");
const { default: TwoFactorPage } = await import("@/app/oauth/2fa/page");

/** Where the page sent them, or null when it drew itself instead. */
async function landing(run: () => Promise<unknown>): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (caught) {
        if (caught instanceof Redirected) return caught.to;
        throw caught;
    }
}

const noParams = Promise.resolve({});

beforeEach(() => {
    session = null;
    pendingChallenge = null;
});

describe("the sign-in page", () => {
    it("draws the form for somebody who is not signed in", async () => {
        expect(await landing(() => LoginPage({ searchParams: noParams }))).toBeNull();
    });

    it("turns an already signed-in visitor around", async () => {
        session = { id: "ada" };
        expect(await landing(() => LoginPage({ searchParams: noParams }))).toBe("/");
    });

    it("honours where the link was pointing", async () => {
        session = { id: "ada" };
        const params = Promise.resolve({ redirect: "/chat" });
        expect(await landing(() => LoginPage({ searchParams: params }))).toBe("/chat");
    });

    it("does not follow that pointer off this instance", async () => {
        session = { id: "ada" };
        const params = Promise.resolve({ redirect: "//example.com" });
        expect(await landing(() => LoginPage({ searchParams: params }))).toBe("/");
    });

    it("sends a half-finished sign-in to the challenge, session or no session", async () => {
        pendingChallenge = "grace";
        expect(await landing(() => LoginPage({ searchParams: noParams }))).toBe("/oauth/2fa");

        session = { id: "ada" };
        expect(await landing(() => LoginPage({ searchParams: noParams }))).toBe("/oauth/2fa");
    });
});

describe("the challenge page", () => {
    it("asks for the code while there is a challenge to answer", async () => {
        pendingChallenge = "grace";
        expect(await landing(() => TwoFactorPage())).toBeNull();
    });

    it("turns a signed-in visitor around when there is nothing left to answer", async () => {
        session = { id: "ada" };
        expect(await landing(() => TwoFactorPage())).toBe("/");
    });

    it("still falls back to the authenticator for somebody who is not signed in", async () => {
        // The challenge cannot be resolved from here, but better-auth may still
        // honour the cookie. Somebody mid-sign-in keeps the code field.
        expect(await landing(() => TwoFactorPage())).toBeNull();
    });
});
