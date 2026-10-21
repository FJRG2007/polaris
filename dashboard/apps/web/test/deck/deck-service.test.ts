/**
 * The Stream Deck's catalogue and runs.
 *
 * What this pins: an action is offered only when the deck's key carries the
 * permission it needs, and the same check refuses a press of one it may not
 * use; an app's actions come from the extension registry, never over one of
 * core's ids; settings are validated before anything runs; a press reaches the
 * MCP tool an assistant would call, through that tool's own scope and schema.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeckAction, DeckCaller } from "@/lib/deck/types";

const calls: { name: string; input: unknown; scopes: readonly string[] }[] = [];
let appActions: AppDeckAction[] = [];
let presence = "auto";
const presenceWrites: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { notification: { count: async () => 3 } }
}));
vi.mock("@/lib/chat/chat-service", () => ({
    unreadTotal: async () => ({ messages: 7, conversations: 2 })
}));
vi.mock("@/lib/presence-service", () => ({
    presenceChoiceOf: async () => ({
        choice: presence,
        until: null,
        scheduled: false,
        nextChangeAt: null
    }),
    setPresenceChoice: async (_userId: string, choice: string) => {
        presenceWrites.push(choice);
        presence = choice;
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({ appDeckActions: async () => appActions }));
vi.mock("@/lib/mcp/catalog", () => {
    const tool = (
        name: string,
        scope: string,
        input: z.ZodTypeAny,
        structured: unknown = null
    ) => ({
        name,
        scope,
        input,
        run: async (args: unknown, caller: { scopes: readonly string[] }) => {
            calls.push({ name, input: args, scopes: caller.scopes });
            return { text: "", structured };
        }
    });
    return {
        mcpTools: async () => [
            tool(
                "chat_send",
                "chat.use",
                z.object({ conversationId: z.string().uuid(), body: z.string().min(1) })
            ),
            tool("chat_conversations", "chat.use", z.object({}), {
                conversations: [{ id: "c1", name: "general" }]
            }),
            tool("deploy_restart", "deploy.manage", z.object({ service: z.string() })),
            tool("places_device_control", "places.control", z.object({}).passthrough()),
            tool("places_devices", "places.read", z.object({}).passthrough(), {
                devices: [
                    {
                        id: "d1",
                        name: "Lamp",
                        state: "on",
                        online: true,
                        operable: true,
                        actions: []
                    }
                ]
            })
        ]
    };
});

const service = await import("@/lib/deck/deck-service");
const core = await import("@/lib/deck/core-actions");

const words = (key: string) => key;
const CONVERSATION = "11111111-1111-4111-8111-111111111111";

function caller(scopes: string[]): DeckCaller {
    return { userId: "u1", isAdmin: false, keyId: "k1", scopes, locale: "en-US" };
}

const lamp: AppDeckAction = {
    id: "places.device-toggle",
    kind: "toggle",
    area: "places",
    icon: "lightbulb",
    label: { "en-US": "Switch a device", "es-ES": "Encender o apagar" },
    scope: "home.control",
    options: z.object({ deviceId: z.string() }),
    fields: [],
    run: {
        tool: "places_device_control",
        input: (options, press) => ({
            deviceId: options.deviceId,
            action: press.current?.on ? "turn-off" : "turn-on"
        })
    },
    read: {
        tool: "places_devices",
        input: (options) => ({ deviceId: options.deviceId }),
        pick: (structured) => {
            const device = (structured as { devices: { state: string }[] }).devices[0];
            return { tone: "ok", on: device?.state === "on" };
        }
    }
};

beforeEach(() => {
    calls.length = 0;
    presenceWrites.length = 0;
    presence = "auto";
    appActions = [];
});

describe("deckCatalogue", () => {
    it("offers only what needs no permission to a key that carries none", async () => {
        const ids = (await service.deckCatalogue(caller([]), words)).map((action) => action.id);
        expect(ids.sort()).toEqual(["polaris.notifications", "polaris.open", "status.presence"]);
    });

    it("adds an area's actions once the key carries its permission", async () => {
        const ids = (await service.deckCatalogue(caller(["chat.use"]), words)).map((a) => a.id);
        expect(ids).toEqual(expect.arrayContaining(["chat.send", "chat.unread", "chat.open"]));
        expect(ids).not.toContain("deploy.restart");
    });

    it("reads a picker's choices through the tool, as the key", async () => {
        const send = (await service.deckCatalogue(caller(["chat.use"]), words)).find(
            (action) => action.id === "chat.send"
        );
        expect(send?.options[0]).toMatchObject({
            name: "conversationId",
            type: "choice",
            choices: [{ value: "c1", label: "general" }]
        });
    });

    it("offers an installed app's action only with its permission, in the reader's language", async () => {
        appActions = [lamp];
        const without = await service.deckCatalogue(caller([]), words);
        expect(without.some((action) => action.id === lamp.id)).toBe(false);
        const withScope = await service.deckCatalogue(
            { ...caller(["home.control"]), locale: "es-ES" },
            words
        );
        expect(withScope.find((action) => action.id === lamp.id)).toMatchObject({
            label: "Encender o apagar",
            live: true
        });
    });

    it("never lets an app take one of core's ids", async () => {
        appActions = [{ ...lamp, id: "chat.send", scope: "home.control" }];
        const offered = await service.deckCatalogue(caller(["home.control", "chat.use"]), words);
        expect(offered.filter((action) => action.id === "chat.send")).toHaveLength(1);
        expect(offered.find((action) => action.id === "chat.send")?.area).toBe("chat");
    });
});

describe("runDeckAction", () => {
    it("refuses an action it does not know", async () => {
        expect(
            await service.runDeckAction(caller([]), { action: "nope.x", options: {} }, words)
        ).toEqual({
            ok: false,
            message: "deck.errors.unknownAction"
        });
    });

    it("refuses a press the key may not make, before running anything", async () => {
        const result = await service.runDeckAction(
            caller([]),
            { action: "chat.send", options: { conversationId: CONVERSATION, body: "hi" } },
            words
        );
        expect(result).toEqual({ ok: false, message: "deck.errors.notAllowed" });
        expect(calls).toHaveLength(0);
    });

    it("refuses settings that do not parse", async () => {
        const result = await service.runDeckAction(
            caller(["chat.use"]),
            { action: "chat.send", options: { conversationId: "not-a-uuid", body: "" } },
            words
        );
        expect(result).toEqual({ ok: false, message: "deck.errors.badOptions" });
        expect(calls).toHaveLength(0);
    });

    it("sends a message through the chat tool, as the key", async () => {
        const result = await service.runDeckAction(
            caller(["chat.use"]),
            {
                action: "chat.send",
                options: { conversationId: CONVERSATION, body: "  on my way " }
            },
            words
        );
        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([
            {
                name: "chat_send",
                input: { conversationId: CONVERSATION, body: "on my way" },
                scopes: ["chat.use"]
            }
        ]);
    });

    it("toggles a status and goes back to automatic on the second press", async () => {
        const first = await service.runDeckAction(
            caller([]),
            { action: "status.presence", options: { choice: "busy" } },
            words
        );
        expect(first).toEqual({ ok: true, state: { tone: "warn", on: true } });
        await service.runDeckAction(
            caller([]),
            { action: "status.presence", options: { choice: "busy" } },
            words
        );
        expect(presenceWrites).toEqual(["busy", "auto"]);
    });

    it("runs an app's action through its tool, with the finer scope its permission grants", async () => {
        appActions = [lamp];
        const result = await service.runDeckAction(
            caller(["home.read", "home.control"]),
            { action: lamp.id, options: { deviceId: "d1" } },
            words
        );
        expect(result).toEqual({ ok: true, state: { tone: "ok", on: true } });
        const control = calls.find((call) => call.name === "places_device_control");
        // The lamp read as on, so the press turns it off.
        expect(control?.input).toEqual({ deviceId: "d1", action: "turn-off" });
        expect(control?.scopes).toContain("places.control");
    });
});

describe("readDeckStates", () => {
    it("reads each watched key and reads a gone or forbidden one as idle", async () => {
        const { readings, chat } = await service.readDeckStates(
            caller(["chat.use"]),
            [
                { key: "a", action: "chat.unread", options: {} },
                { key: "b", action: "deploy.restart", options: {} },
                { key: "c", action: "gone.action", options: {} },
                { key: "d", action: "polaris.notifications", options: {} }
            ],
            words
        );
        expect(readings).toEqual([
            { key: "a", state: { tone: "warn", value: "7" } },
            { key: "b", state: { tone: "idle" } },
            { key: "c", state: { tone: "idle" } },
            { key: "d", state: { tone: "warn", value: "3" } }
        ]);
        expect(chat).toBe(true);
    });
});

describe("deploymentState", () => {
    it("colours a deployment by how it went and keeps Deploy's word for it", () => {
        expect(core.deploymentState("running")).toEqual({ tone: "ok", detail: "running" });
        expect(core.deploymentState("failed")).toEqual({ tone: "bad", detail: "failed" });
        expect(core.deploymentState("building")).toEqual({ tone: "warn", detail: "building" });
        expect(core.deploymentState("cancelled")).toEqual({ tone: "idle", detail: "cancelled" });
    });
});

describe("readWatch", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

    it("reads the keys from base64url JSON, and absent as none", () => {
        expect(service.readWatch(null)).toEqual([]);
        expect(service.readWatch(encode([{ key: "a", action: "chat.unread" }]))).toEqual([
            { key: "a", action: "chat.unread", options: {} }
        ]);
    });

    it("refuses anything that is not a list of keys", () => {
        expect(service.readWatch("%%%")).toBeNull();
        expect(service.readWatch(encode({ key: "a" }))).toBeNull();
        expect(
            service.readWatch(
                encode(Array.from({ length: 65 }, (_, i) => ({ key: `${i}`, action: "x" })))
            )
        ).toBeNull();
        expect(service.readWatch("a".repeat(20_000))).toBeNull();
    });
});
