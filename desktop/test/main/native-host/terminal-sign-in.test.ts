/**
 * Polaris Terminal signing in through the desktop app: only for the server the
 * app shows, only once the person said yes here, and the refusal reasons the
 * terminal acts on.
 */

import { describe, expect, it } from "vitest";
import { answerTerminalSignIn, type PendingTerminal, type TerminalSignInDeps } from "@/main/native-host/terminal-sign-in";

const SERVER = "https://polaris.example";
const message = { type: "terminal-sign-in" as const, server: SERVER, userCode: "bcdf-ghjk" };
const PENDING = { userCode: "BCDFGHJK", device: "desk", os: "Windows", scopes: ["polar.use"] };

function deps(overrides: Partial<TerminalSignInDeps> & { approve?: boolean; describeStatus?: number } = {}) {
    const posts: { path: string; body: unknown }[] = [];
    const asked: PendingTerminal[] = [];
    const value: TerminalSignInDeps = {
        servers: () => [SERVER],
        post: async (_origin, path, body) => {
            posts.push({ path, body });
            if (path.endsWith("/describe")) return { status: overrides.describeStatus ?? 200, body: { pending: PENDING } };
            return { status: 200, body: { ok: true } };
        },
        confirm: async (pending) => {
            asked.push(pending);
            return overrides.approve ?? true;
        },
        ...overrides
    };
    return { value, posts, asked };
}

describe("a terminal's sign-in through the desktop app", () => {
    it("shows the request, and approves it once the person says yes", async () => {
        const { value, posts, asked } = deps();
        expect(await answerTerminalSignIn(message, value)).toEqual({ ok: true });
        expect(asked).toEqual([PENDING]);
        expect(posts).toEqual([
            { path: "/api/terminal/authorize/describe", body: { userCode: "BCDFGHJK" } },
            { path: "/api/terminal/authorize/answer", body: { userCode: "BCDFGHJK", approve: true } }
        ]);
    });

    it("refuses it on the server when the person says no", async () => {
        const { value, posts } = deps({ approve: false });
        expect(await answerTerminalSignIn(message, value)).toEqual({ ok: false, reason: "refused" });
        expect(posts.at(-1)).toEqual({ path: "/api/terminal/authorize/answer", body: { userCode: "BCDFGHJK", approve: false } });
    });

    it("answers nothing for another server, and says when it is signed out or offline", async () => {
        const other = deps();
        expect(await answerTerminalSignIn({ ...message, server: "https://elsewhere.example" }, other.value)).toEqual({ ok: false, reason: "other-server" });
        expect(other.posts).toEqual([]);
        const signedOut = deps({ describeStatus: 401 });
        expect(await answerTerminalSignIn(message, signedOut.value)).toEqual({ ok: false, reason: "signed-out" });
        expect(signedOut.asked).toEqual([]);
        const offline = deps({ post: async () => null });
        expect(await answerTerminalSignIn(message, offline.value)).toEqual({ ok: false, reason: "unreachable" });
    });

    it("keeps one question on screen at a time", async () => {
        let release: (approved: boolean) => void = () => undefined;
        const slow = deps({ confirm: () => new Promise<boolean>((resolve) => (release = resolve)) });
        const first = answerTerminalSignIn(message, slow.value);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await answerTerminalSignIn(message, deps().value)).toEqual({ ok: false, reason: "refused" });
        release(true);
        expect(await first).toEqual({ ok: true });
    });
});
