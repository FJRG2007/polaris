/**
 * An old "Continue on phone" link. The feature is gone - a session opens from
 * Polar on any signed-in device - so every such link, signed in or not, gets
 * the ordinary unavailable page and never a crash or a redirect.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@/lib/session", () => ({ getSession: async () => (state.user ? { user: state.user } : null) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/components/public-shell", () => ({ LinkUnavailable: () => null }));

const { default: ContinuePage } = await import("@/app/continue/[code]/page");
const { LinkUnavailable } = await import("@/components/public-shell");

beforeEach(() => {
    state.user = null;
});

describe("an old Continue on phone link", () => {
    it("answers the unavailable page when signed out", async () => {
        const page = (await ContinuePage()) as { type: unknown; props: { signedIn: boolean; message: string } };
        expect(page.type).toBe(LinkUnavailable);
        expect(page.props).toMatchObject({ signedIn: false, message: "continueSession.gone" });
    });

    it("answers the same page to its owner, naming no session", async () => {
        state.user = { id: "owner" };
        const page = (await ContinuePage()) as { type: unknown; props: { signedIn: boolean } };
        expect(page.type).toBe(LinkUnavailable);
        expect(page.props.signedIn).toBe(true);
    });
});
