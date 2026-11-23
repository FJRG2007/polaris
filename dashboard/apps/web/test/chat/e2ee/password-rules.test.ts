/**
 * The password rules a new OPAQUE password must keep, checked in the browser
 * because the server never sees it: length, the account's own name, and the
 * breach corpus by k-anonymity. A refused password never reaches a registration.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({ started: [] as string[] }));
vi.mock("@/lib/chat/e2ee/password-worker-client", () => ({
    startPasswordRegistration: async (password: string) => {
        worker.started.push(password);
        return { state: "s", registrationRequest: "r" };
    }
}));

const rules = await import("@/lib/chat/e2ee/password-rules");

const identity = { name: "Ada Lovelace", username: "ada", email: "ada.lovelace@example.test" };

/** A range that knows exactly one password, and records every prefix asked. */
function corpus(known: string) {
    const asked: string[] = [];
    const hash = createHash("sha1").update(known).digest("hex").toUpperCase();
    const range = async (prefix: string) => {
        asked.push(prefix);
        return prefix === hash.slice(0, 5) ? `${hash.slice(5)}:42\r\n0000000000000000000000000000000000A:0` : "";
    };
    return { asked, range };
}

beforeEach(() => {
    worker.started.length = 0;
});

describe("password rules under OPAQUE", () => {
    it("refuses a short or an overlong password", async () => {
        const { range } = corpus("x");
        expect(await rules.passwordRuleProblem("short", identity, range)).toBe("length");
        expect(await rules.passwordRuleProblem("y".repeat(257), identity, range)).toBe("length");
    });

    it("refuses a password built from the account", async () => {
        const { range } = corpus("x");
        expect(await rules.passwordRuleProblem("lovelace-2026!", identity, range)).toBe("identity");
    });

    it("refuses a breached password and sends only five hex characters", async () => {
        const { asked, range } = corpus("purple elephant 77");
        expect(await rules.passwordRuleProblem("purple elephant 77", identity, range)).toBe("breached");
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/^[0-9A-F]{5}$/);
    });

    it("fails open when the corpus cannot be reached, like every breach check here", async () => {
        expect(await rules.passwordRuleProblem("purple elephant 77", identity, async () => null)).toBeNull();
    });

    it("never starts a registration for a refused password", async () => {
        const { range } = corpus("purple elephant 77");
        await expect(rules.startCheckedRegistration("purple elephant 77", identity, range)).rejects.toMatchObject({
            problem: "breached"
        });
        await expect(rules.startCheckedRegistration("short", identity, range)).rejects.toBeInstanceOf(
            rules.PasswordRuleError
        );
        expect(worker.started).toEqual([]);
        await rules.startCheckedRegistration("quiet harbour lantern", identity, range);
        expect(worker.started).toEqual(["quiet harbour lantern"]);
    });

    it("asks this Polaris for the range by default", async () => {
        const fetched: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            fetched.push(url);
            return new Response("", { status: 200 });
        });
        try {
            expect(await rules.passwordRuleProblem("quiet harbour lantern", identity)).toBeNull();
            expect(fetched).toHaveLength(1);
            expect(fetched[0]).toMatch(/^\/api\/polaris\/pwned\/[0-9A-F]{5}$/);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
