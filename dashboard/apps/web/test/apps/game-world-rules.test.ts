/**
 * What the rules screen can show when the server is not there to ask.
 *
 * Three things were wrong at once and they were one thing: nothing the server
 * said was ever kept. A stopped server answered nothing, so every switch drew
 * empty - which reads as "this world has no rules" rather than "nobody can ask
 * right now" - and the difficulty somebody had set live was gone by the next
 * screen, because only the container knew it.
 *
 * The third was what the reader actually saw: the daemon answers in place of a
 * stopped server, naming a container id nobody has ever seen, and that string was
 * quoted onto the screen. This file's own module says it must not be, so that is
 * asserted here rather than left to a reviewer.
 *
 * A remembered value is something to look at and never something to appear to
 * change, so `answering` is asserted everywhere alongside the values: it is what
 * the screen disables its controls on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The install's config column, which is where the last answer is kept. */
let stored: string | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ config: stored }),
            update: async (args: { data: { config: string } }) => {
                stored = args.data.config;
                return {};
            }
        }
    }
}));

/** What the container would say, or null for a server that cannot be opened. */
let talking: string | null = null;

vi.mock("@/lib/apps/minecraft/service", () => ({
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        run: (server: unknown) => Promise<unknown>
    ) => {
        // A server that is off cannot be opened at all, and this is the shape of
        // the refusal: the daemon's, about a container, not the game's.
        if (talking === null) {
            throw new Error("Error response from daemon: container 0000000000 is not running");
        }
        return run({ edition: "java", run: async () => ({ output: talking }), say: async () => talking });
    }
}));

const { readRulesFor, readWorldRules, setWorldDifficulty, setWorldRule } = await import(
    "@/lib/apps/minecraft/rules-service"
);

const OWNER = "0190c1d2-0000-7000-8000-000000000001";
const SERVER = "0190c1d2-0000-7000-8000-0000000000a1";

/** A full reply, the way a running server answers the one batched read. */
const ANSWERED = [
    "Gamerule keepInventory is currently set to: true",
    "Gamerule fallDamage is currently set to: false",
    "The difficulty is Normal"
].join("\n");

beforeEach(() => {
    stored = null;
    talking = ANSWERED;
});

describe("what a server that will not answer is allowed to say", () => {
    it("never quotes the daemon at the reader", async () => {
        // The reported one, word for word: "The server answered: Error response
        // from daemon: container ... is not running", on a screen about rules.
        const said = "Error response from daemon: container 0000000000 is not running";
        const rules = await readWorldRules({
            edition: "java",
            run: async () => ({ output: said }),
            say: async () => said
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stand-in for the container
        } as any);

        expect(rules.reason).toBeTruthy();
        expect(rules.reason).not.toContain("daemon");
        expect(rules.reason).not.toContain("container");
        expect(rules.reason).not.toContain("0000000000");
        expect(rules.answering).toBe(false);
    });
});

describe("the rules of a server that is switched off", () => {
    it("are the ones it last gave, dated, and not changeable", async () => {
        const live = await readRulesFor(OWNER, SERVER);
        expect(live.values.keepInventory).toBe("true");
        expect(live.difficulty).toBe("normal");
        expect(live.asOf).toBeNull();
        expect(live.answering).toBe(true);

        // Somebody stops the server. The rules are still the game's.
        talking = null;
        const kept = await readRulesFor(OWNER, SERVER);

        expect(kept.values.keepInventory).toBe("true");
        expect(kept.values.fallDamage).toBe("false");
        expect(kept.difficulty).toBe("normal");
        expect(kept.asOf).toBeTruthy();
        // The half that matters as much as the values: nothing here may look
        // like something that can be switched.
        expect(kept.answering).toBe(false);
    });

    it("say nothing at all when it has never answered", async () => {
        talking = null;
        const rules = await readRulesFor(OWNER, SERVER);

        expect(rules.values).toEqual({});
        expect(rules.asOf).toBeNull();
        expect(rules.answering).toBe(false);
        expect(rules.reason).toBeTruthy();
    });

    it("leave out a rule this Polaris no longer has", async () => {
        // Written by an older Polaris against an older world. A name the
        // catalogue has since dropped must not reach a screen as though the
        // server had just said it.
        stored = JSON.stringify({
            minecraftRules: {
                values: { keepInventory: "true", notARuleAnyMore: "true" },
                difficulty: "hard",
                at: "2026-09-01T10:00:00.000Z"
            }
        });
        talking = null;
        const rules = await readRulesFor(OWNER, SERVER);

        expect(rules.values.keepInventory).toBe("true");
        expect(rules.values.notARuleAnyMore).toBeUndefined();
        expect(rules.difficulty).toBe("hard");
    });
});

describe("a change made while the server is up", () => {
    it("is what the screen shows after it goes down", async () => {
        await readRulesFor(OWNER, SERVER);
        talking = "Gamerule keepInventory is now set to: false";
        expect(await setWorldRule(OWNER, SERVER, "keepInventory", "false")).toBe("false");

        talking = null;
        const kept = await readRulesFor(OWNER, SERVER);
        // Merged rather than replacing: setting one rule must not lose the two
        // dozen that were read a minute earlier.
        expect(kept.values.keepInventory).toBe("false");
        expect(kept.values.fallDamage).toBe("false");
    });

    it("keeps a difficulty set live, which only the container knew", async () => {
        talking = "The difficulty is Hard";
        await setWorldDifficulty(OWNER, SERVER, "hard");

        talking = null;
        expect((await readRulesFor(OWNER, SERVER)).difficulty).toBe("hard");
    });
});
