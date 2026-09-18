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

/** How many times it has been written. The column is shared with everything else
 *  about the install, so writing to it is a thing worth counting. */
let writes = 0;

/** The values set from Polaris, keyed by rule. */
type Setting = {
    id: string;
    installedAppId: string;
    rule: string;
    value: string;
    setAt: Date;
    setById: string | null;
    appliedAt: Date | null;
    failure: string | null;
};
const settings = new Map<string, Setting>();

type Where = { installedAppId?: string; rule?: string; appliedAt?: null; failure?: null };
const matching = (where: Where) =>
    [...settings.values()].filter(
        (row) =>
            (where.rule === undefined || row.rule === where.rule) &&
            (where.appliedAt === undefined || row.appliedAt === null) &&
            (where.failure === undefined || row.failure === null)
    );

vi.mock("@polaris/db", () => ({
    prisma: {
        gameRuleSetting: {
            findMany: async ({ where }: { where: Where }) => matching(where),
            count: async ({ where }: { where: Where }) => matching(where).length,
            findUnique: async ({ where }: { where: { installedAppId_rule: { rule: string } } }) =>
                settings.get(where.installedAppId_rule.rule) ?? null,
            upsert: async (args: {
                where: { installedAppId_rule: { rule: string } };
                create: Omit<Setting, "id">;
                update: Partial<Setting>;
            }) => {
                const rule = args.where.installedAppId_rule.rule;
                const current = settings.get(rule);
                settings.set(
                    rule,
                    current ? { ...current, ...args.update } : { id: rule, ...args.create }
                );
            },
            update: async (args: { where: { id: string }; data: Partial<Setting> }) => {
                const current = settings.get(args.where.id);
                if (current) settings.set(current.rule, { ...current, ...args.data });
            },
            updateMany: async (args: { where: Where; data: Partial<Setting> }) => {
                for (const row of matching(args.where)) {
                    settings.set(row.rule, { ...row, ...args.data });
                }
            },
            deleteMany: async (args: { where: Where }) => {
                for (const row of matching(args.where)) settings.delete(row.rule);
            }
        },
        installedApp: {
            findUnique: async () => ({ config: stored, catalogId: "minecraft" }),
            update: async (args: { data: { config: string } }) => {
                stored = args.data.config;
                writes += 1;
                return {};
            }
        }
    }
}));

/** What the container would say, or null for a server that cannot be opened. */
let talking: string | null = null;

/** Every command the server was handed, in order. */
const told: string[][] = [];

/** How many times the server was opened. */
let opened = 0;

/** What the server answers to a `gamerule` set, when that differs from `talking`. */
let setReply: string | null = null;

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        run: (server: unknown) => Promise<unknown>
    ) => {
        opened += 1;
        // A server that is off cannot be opened at all, and this is the shape of
        // the refusal: the daemon's, about a container, not the game's.
        if (talking === null) {
            throw new Error("Error response from daemon: container 0000000000 is not running");
        }
        return run({
            edition: "java",
            run: async () => ({ output: talking }),
            say: async (argv: string[]) => {
                told.push(argv);
                return argv[0] === "gamerule" && setReply !== null ? setReply : talking;
            }
        });
    }
}));

const {
    applyPendingRules,
    readRulesFor,
    readWorldRules,
    rememberDifficulty,
    setWorldDifficulty,
    setWorldRule
} = await import("@polaris-app/game-servers/src/lib/minecraft/rules-service");

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
    writes = 0;
    talking = ANSWERED;
    setReply = null;
    settings.clear();
    told.length = 0;
    opened = 0;
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
        expect(await setWorldRule(OWNER, SERVER, "keepInventory", "false")).toEqual({
            value: "false",
            queued: false
        });

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

describe("what is kept, and how old it says it is", () => {
    it("keeps a difficulty a later read did not name", async () => {
        await readRulesFor(OWNER, SERVER);

        // Rules came back and no difficulty line did. That is the server not
        // saying, never the world having none - so the last one it gave stands.
        talking = "Gamerule keepInventory is currently set to: false";
        expect((await readRulesFor(OWNER, SERVER)).values.keepInventory).toBe("false");

        talking = null;
        expect((await readRulesFor(OWNER, SERVER)).difficulty).toBe("normal");
    });

    it("does not date old values by when a different one was written", async () => {
        stored = JSON.stringify({
            minecraftRules: {
                values: { keepInventory: "true", fallDamage: "false" },
                at: "2026-09-01T10:00:00.000Z"
            }
        });

        talking = "Gamerule keepInventory is now set to: false";
        await setWorldRule(OWNER, SERVER, "keepInventory", "false");

        talking = null;
        const kept = await readRulesFor(OWNER, SERVER);
        expect(kept.values.keepInventory).toBe("false");
        // The other one was read a fortnight ago and still was a moment ago. A
        // blob written a field at a time is only as fresh as its stalest part,
        // and the screen puts this date beside all of it.
        expect(kept.asOf).toBe("2026-09-01T10:00:00.000Z");
    });

    it("does not date an old difficulty by a rule being set", async () => {
        stored = JSON.stringify({
            minecraftRules: { values: {}, difficulty: "hard", at: "2026-09-01T10:00:00.000Z" }
        });

        talking = "Gamerule keepInventory is now set to: false";
        await setWorldRule(OWNER, SERVER, "keepInventory", "false");

        talking = null;
        const kept = await readRulesFor(OWNER, SERVER);
        expect(kept.difficulty).toBe("hard");
        expect(kept.asOf).toBe("2026-09-01T10:00:00.000Z");
    });

    it("does not date old values by a difficulty saved in Settings", async () => {
        // The reported shape of it: a server down for days, somebody saves the
        // difficulty on the other screen, and the rules it last gave start
        // claiming they were read seconds ago from a server nobody has reached.
        stored = JSON.stringify({
            minecraftRules: {
                values: { keepInventory: "true", fallDamage: "false" },
                at: "2026-09-01T10:00:00.000Z"
            }
        });

        await rememberDifficulty(SERVER, "hard");

        talking = null;
        const kept = await readRulesFor(OWNER, SERVER);
        expect(kept.difficulty).toBe("hard");
        expect(kept.values.keepInventory).toBe("true");
        expect(kept.asOf).toBe("2026-09-01T10:00:00.000Z");
    });

    it("writes nothing when a read only confirms what is already kept", async () => {
        await readRulesFor(OWNER, SERVER);
        const settled = writes;

        await readRulesFor(OWNER, SERVER);
        await readRulesFor(OWNER, SERVER);
        // This column carries everything else about the install too, and each
        // write of it is a read and a replace. A screen being looked at is not a
        // reason to join that queue.
        expect(writes).toBe(settled);
    });
});

describe("a server that answers but will not read a rule back", () => {
    it("shows what was kept, dated, with setting one still open", async () => {
        await readRulesFor(OWNER, SERVER);

        // Minecraft 26.2: it sets a rule perfectly well and refuses to say what
        // one is currently.
        talking = "Incorrect argument for command\ngamerule keepInventory<--[HERE]";
        const rules = await readRulesFor(OWNER, SERVER);

        expect(rules.values.keepInventory).toBe("true");
        expect(rules.difficulty).toBe("normal");
        // Both halves matter. The controls work, so the screen must not lock
        // them - and the positions are old, so it is given the date that says so
        // rather than letting them pass for a reading.
        expect(rules.answering).toBe(true);
        expect(rules.asOf).toBeTruthy();
    });
});

describe("what is set from Polaris", () => {
    it("is kept while the server is off and handed over when it answers", async () => {
        talking = null;
        const change = await setWorldRule(OWNER, SERVER, "keepInventory", "false");
        expect(change).toEqual({ value: "false", queued: true });

        const waiting = await readRulesFor(OWNER, SERVER);
        expect(waiting.values.keepInventory).toBe("false");
        expect(waiting.pending).toContain("keepInventory");
        expect(waiting.changeable).toBe(true);

        // The server starts, still on its old value.
        talking = ANSWERED;
        setReply = "Gamerule keepInventory is now set to: false";
        const applied = await readRulesFor(OWNER, SERVER);
        expect(told).toContainEqual(["gamerule", "keepInventory", "false"]);
        expect(applied.values.keepInventory).toBe("false");
        expect(applied.pending).toEqual([]);
    });

    it("puts back a value the game drifted from", async () => {
        setReply = "Gamerule keepInventory is now set to: false";
        await setWorldRule(OWNER, SERVER, "keepInventory", "false");
        told.length = 0;

        // Somebody typed /gamerule keepInventory true in the console.
        const read = await readRulesFor(OWNER, SERVER);
        expect(told).toContainEqual(["gamerule", "keepInventory", "false"]);
        expect(read.values.keepInventory).toBe("false");
    });

    it("leaves a value the server refused out, and says why", async () => {
        setReply = "Incorrect argument for command";
        await expect(setWorldRule(OWNER, SERVER, "keepInventory", "false")).rejects.toThrow(
            /refused/
        );
        const read = await readRulesFor(OWNER, SERVER);
        expect(read.values.keepInventory).toBe("true");
        expect(read.pending).toEqual([]);
    });

    it("waits for a difficulty set while the server is off", async () => {
        talking = null;
        expect(await setWorldDifficulty(OWNER, SERVER, "hard")).toEqual({
            value: "hard",
            queued: true
        });
        talking = ANSWERED;
        const applied = await readRulesFor(OWNER, SERVER);
        expect(told).toContainEqual(["difficulty", "hard"]);
        expect(applied.difficulty).toBe("hard");
        expect(applied.pending).toEqual([]);
    });
});

describe("the cron's look for waiting changes", () => {
    const row = (rule: string, value: string): Setting => ({
        id: rule,
        installedAppId: SERVER,
        rule,
        value,
        setAt: new Date(),
        setById: null,
        appliedAt: null,
        failure: null
    });

    it("leaves the server alone when all that waits is a rule this Polaris does not have", async () => {
        settings.set("retiredRule", row("retiredRule", "true"));
        settings.set("difficulty", row("difficulty", "impossible"));
        await applyPendingRules(OWNER, SERVER);
        expect(opened).toBe(0);
    });

    it("opens the server when a known rule waits", async () => {
        settings.set("keepInventory", row("keepInventory", "false"));
        await applyPendingRules(OWNER, SERVER);
        expect(told).toContainEqual(["gamerule", "keepInventory", "false"]);
        expect(settings.get("keepInventory")?.appliedAt).not.toBeNull();
    });
});
