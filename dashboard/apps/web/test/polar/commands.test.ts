/**
 * Polar's own "/" commands: the shared schema the form and the routes both
 * read, and the routes that keep them - scoped to their owner, bounded, and
 * refusing a shortcut that is taken or a model the person cannot use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    automaticChoice,
    commandShortcutSchema,
    commandText,
    firstLine,
    POLAR_COMMAND_MOST,
    POLAR_COMMAND_PROMPT_MAX,
    polarCommandInputSchema,
    shortcutIssue
} from "@/lib/polar/shared";

const ID = "11111111-1111-4111-8111-111111111111";

const state = {
    viewingAs: null as null | string,
    count: 0,
    taken: false,
    updated: 1,
    deleted: 1,
    created: [] as unknown[],
    where: [] as unknown[]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () => ({ id: "u1", name: "Ana", viewingAs: state.viewingAs })
}));
vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/polar/models", () => ({
    polarModelOptions: async () => [
        { provider: "openai", payers: ["own"], models: [{ provider: "openai", model: "mini" }] }
    ]
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarCommand: {
            findMany: async (args: { where: unknown }) => {
                state.where.push(args.where);
                return [{ id: ID, shortcut: "tldr", prompt: "Sum up", choice: { broken: true } }];
            },
            count: async () => state.count,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                if (state.taken) throw Object.assign(new Error("unique"), { code: "P2002" });
                state.created.push(data);
                return { id: ID, ...data };
            },
            updateMany: async (args: { where: unknown }) => {
                state.where.push(args.where);
                if (state.taken) throw Object.assign(new Error("unique"), { code: "P2002" });
                return { count: state.updated };
            },
            deleteMany: async (args: { where: unknown }) => {
                state.where.push(args.where);
                return { count: state.deleted };
            }
        }
    }
}));

const listRoute = await import("@/app/api/polar/commands/route");
const oneRoute = await import("@/app/api/polar/commands/[id]/route");

const params = { params: Promise.resolve({ id: ID }) };
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const post = (body: unknown) =>
    listRoute.POST(new Request("http://x/api/polar/commands", json(body)));
const valid = {
    shortcut: " /TL-dr ",
    prompt: "  Sum this up\nin three lines ",
    choice: automaticChoice()
};

beforeEach(() => {
    state.viewingAs = null;
    state.count = 0;
    state.taken = false;
    state.updated = 1;
    state.deleted = 1;
    state.created = [];
    state.where = [];
});

describe("the command schema", () => {
    it("normalizes a shortcut: no slash, no spaces around, lowercase", () => {
        expect(commandShortcutSchema.parse("  /Explain-Code ")).toBe("explain-code");
    });

    it.each([
        ["has a space", "two words", "format"],
        ["has another character", "sum_up", "format"],
        ["starts with a hyphen", "-x", "format"],
        ["is empty", " / ", "format"],
        ["is too long", "a".repeat(33), "long"],
        ["shadows a built-in command", "/New", "builtin"]
    ])("refuses a shortcut that %s", (_label, value, issue) => {
        expect(shortcutIssue(value, [])).toBe(issue);
    });

    it("refuses a shortcut the person already uses, after normalizing", () => {
        expect(shortcutIssue("/TLDR", ["tldr"])).toBe("taken");
        expect(shortcutIssue("tldr2", ["tldr"])).toBeNull();
    });

    it("trims the prompt and bounds it", () => {
        expect(polarCommandInputSchema.parse(valid).prompt).toBe("Sum this up\nin three lines");
        expect(
            polarCommandInputSchema.safeParse({
                ...valid,
                prompt: "a".repeat(POLAR_COMMAND_PROMPT_MAX + 1)
            }).success
        ).toBe(false);
        expect(polarCommandInputSchema.safeParse({ ...valid, prompt: "   " }).success).toBe(false);
    });

    it("appends what was typed after the shortcut on a line of its own", () => {
        expect(commandText("Translate to French:", "  good morning ")).toBe(
            "Translate to French:\n\ngood morning"
        );
        expect(commandText("Summarize this page", "  ")).toBe("Summarize this page");
    });

    it("describes a prompt by its first line", () => {
        expect(firstLine("\n Sum up \nsecond")).toBe("Sum up");
        expect(firstLine("x".repeat(100), 10)).toBe("xxxxxxxxx…");
    });
});

describe("the command routes", () => {
    it("lists only the owner's commands, reading a broken choice as Automatic", async () => {
        const response = await listRoute.GET();
        const body = (await response.json()) as { commands: Array<{ choice: unknown }> };
        expect(state.where[0]).toEqual({ userId: "u1" });
        expect(body.commands[0]?.choice).toEqual(automaticChoice());
    });

    it("stores a new command normalized", async () => {
        const response = await post(valid);
        expect(response.status).toBe(200);
        expect(state.created[0]).toMatchObject({
            userId: "u1",
            shortcut: "tl-dr",
            prompt: "Sum this up\nin three lines"
        });
    });

    it("refuses an invalid body, a built-in shortcut and extra fields", async () => {
        expect((await post({ ...valid, shortcut: "model" })).status).toBe(400);
        expect((await post({ ...valid, userId: "u2" })).status).toBe(400);
        expect((await post(null)).status).toBe(400);
    });

    it("refuses a model the person cannot use, and accepts one they can", async () => {
        const choice = { kind: "language", provider: "openai", model: "gone" };
        const refused = await post({ ...valid, choice });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: "unknown_model" });
        expect((await post({ ...valid, choice: { ...choice, model: "mini" } })).status).toBe(200);
    });

    it("refuses a taken shortcut and a person at the limit", async () => {
        state.taken = true;
        expect(await (await post(valid)).json()).toEqual({ error: "taken" });
        state.taken = false;
        state.count = POLAR_COMMAND_MOST;
        expect(await (await post(valid)).json()).toEqual({ error: "too_many" });
    });

    it("refuses an administrator viewing as somebody else", async () => {
        state.viewingAs = "u2";
        expect((await post(valid)).status).toBe(403);
    });

    it("edits and deletes only the owner's command; another id is a 404", async () => {
        const patch = (body: unknown) =>
            oneRoute.PATCH(
                new Request(`http://x/api/polar/commands/${ID}`, {
                    method: "PATCH",
                    body: JSON.stringify(body)
                }),
                params
            );
        expect((await patch(valid)).status).toBe(200);
        expect(state.where.at(-1)).toEqual({ id: ID, userId: "u1" });
        state.updated = 0;
        expect((await patch(valid)).status).toBe(404);
        state.deleted = 0;
        const removed = await oneRoute.DELETE(
            new Request(`http://x/api/polar/commands/${ID}`),
            params
        );
        expect(removed.status).toBe(404);
        expect(state.where.at(-1)).toEqual({ id: ID, userId: "u1" });
        const bad = await oneRoute.DELETE(new Request("http://x"), {
            params: Promise.resolve({ id: "x" })
        });
        expect(bad.status).toBe(404);
    });
});
