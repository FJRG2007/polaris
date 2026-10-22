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
const buckets: string[] = [];
const audits: { action: string; actorId: string; metadata: Record<string, unknown> }[] = [];
let throttledBucket: string | null = null;
let appActions: AppDeckAction[] = [];
let presence = "auto";
const presenceWrites: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { notification: { count: async () => 3 } }
}));
vi.mock("@/lib/chat/chat-service", () => ({
    unreadTotal: async () => ({ messages: 7, conversations: 2 })
}));
vi.mock("@/lib/chat/chat-guard", () => ({ guardChat: async () => ({ value: null }) }));
vi.mock("@/lib/chat/call-remote-service", () => ({
    liveCallOf: async () => null,
    deckSounds: async () => []
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
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (bucket: string) => {
        buckets.push(bucket);
        return bucket === throttledBucket
            ? { ok: false, retryAfterMs: 30_000 }
            : { ok: true, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/deploy/api/http", () => ({
    throttleDeployKey: async (keyId: string, changes: boolean) => {
        buckets.push(`deploy-api${changes ? "-change" : ""}:${keyId}`);
        return null;
    }
}));
vi.mock("@/lib/mcp/tools/deploy", () => ({
    DEPLOY_TOOLS: [{ name: "deploy_restart" }, { name: "deploy_deployments" }]
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: {
        action: string;
        actorId: string;
        metadata: Record<string, unknown>;
    }) => {
        audits.push({ action: event.action, actorId: event.actorId, metadata: event.metadata });
    }
}));
vi.mock("@/lib/mcp/catalog", () => {
    const tool = (
        name: string,
        scope: string,
        input: z.ZodTypeAny,
        structured: unknown = null,
        readOnly = structured !== null
    ) => ({
        name,
        scope,
        input,
        readOnly,
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
            tool(
                "chat_mute",
                "chat.use",
                z.object({ conversationId: z.string().uuid(), muted: z.boolean() })
            ),
            tool("chat_conversations", "chat.use", z.object({}), {
                conversations: [{ id: "c1", name: "general" }]
            }),
            tool("deploy_restart", "deploy.manage", z.object({ service: z.string() })),
            tool("places_camera_snapshot", "places.cameras", z.object({}), { image: "x" }),
            tool("databases_query", "databases.read", z.object({}), { rows: [] }),
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

let accountScopes: string[] = [];
vi.mock("@polaris/auth", () => ({ scopesAvailableTo: async () => accountScopes }));

const service = await import("@/lib/deck/deck-service");
const core = await import("@/lib/deck/core-actions");
const tools = await import("@/lib/deck/tool-call");

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
    accountScopes = [];
    calls.length = 0;
    buckets.length = 0;
    audits.length = 0;
    throttledBucket = null;
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
    it("colours a deployment by how it went and names it in the reader's language", () => {
        expect(core.deploymentState("running", "en-US")).toEqual({ tone: "ok", detail: "Running" });
        expect(core.deploymentState("failed", "es-ES")).toEqual({ tone: "bad", detail: "Fallido" });
        expect(core.deploymentState("building", "en-US")).toEqual({
            tone: "warn",
            detail: "Building"
        });
        expect(core.deploymentState("cancelled", "es-ES")).toEqual({
            tone: "idle",
            detail: "Cancelado"
        });
    });

    it("shows only the colour for a status it has no word for", () => {
        expect(core.deploymentState("something-new", "en-US")).toEqual({ tone: "idle" });
    });
});

describe("callTool", () => {
    it("spends the key's change and Deploy budgets and audits a change as the deck", async () => {
        const outcome = await tools.callTool(caller(["deploy.manage"]), "deploy_restart", {
            service: "web/api"
        });
        expect(outcome).toEqual({ ok: true, structured: null });
        expect(buckets).toEqual(["mcp-call:k1", "mcp-change:k1", "deploy-api-change:k1"]);
        expect(audits).toEqual([
            {
                action: "mcp.tool.called",
                actorId: "u1",
                metadata: { tool: "deploy_restart", via: "streamdeck", keyId: "k1" }
            }
        ]);
    });

    it("leaves a read to the deck's own budget and out of the activity", async () => {
        const outcome = await tools.callTool(caller(["chat.use"]), "chat_conversations", {});
        expect(outcome.ok).toBe(true);
        expect(buckets).toEqual([]);
        expect(audits).toEqual([]);
    });

    it("refuses a change over budget in the reader's words, without running it", async () => {
        throttledBucket = "mcp-change:k1";
        const outcome = await tools.callTool(
            { ...caller(["deploy.manage"]), locale: "es-ES" },
            "deploy_restart",
            { service: "web/api" }
        );
        expect(outcome).toEqual({
            ok: false,
            message: "Demasiadas pulsaciones desde este deck. Espera un momento."
        });
        expect(calls).toHaveLength(0);
        expect(audits).toEqual([]);
    });

    it("grants only the finer scopes a deck's actions use", async () => {
        const mcp = tools.mcpCallerFor(
            caller(["home.read", "home.control", "home.manage", "deploy.read"])
        );
        expect(mcp.scopes).toEqual(
            expect.arrayContaining(["places.read", "places.control", "places.routines"])
        );
        expect(mcp.scopes).not.toContain("places.cameras");
        expect(mcp.scopes).not.toContain("databases.read");
        expect(mcp.scopes).not.toContain("databases.write");
        expect(await tools.callTool(caller(["home.read"]), "places_camera_snapshot", {})).toEqual({
            ok: false,
            message: null
        });
        expect(await tools.callTool(caller(["deploy.read"]), "databases_query", {})).toEqual({
            ok: false,
            message: null
        });
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
describe("MCP tools as deck actions", () => {
    it("offers a tool that changes something, with the key's scope, and asks twice", async () => {
        const offered = await service.deckCatalogue(caller(["chat.use"]), words);
        const send = offered.find((action) => action.id === "tool.chat_send");
        expect(send).toMatchObject({ kind: "run", area: "tools", confirm: true, live: false });
        // A field naming one of the person's things is a picker of them.
        expect(send?.options.find((field) => field.name === "conversationId")).toMatchObject({
            type: "choice",
            label: "deck.fields.conversationId",
            choices: [{ value: "c1", label: "general" }]
        });
        expect(offered.some((action) => action.id === "tool.deploy_restart")).toBe(false);
        // Read-only tools have nothing to press.
        expect(offered.some((action) => action.id === "tool.chat_conversations")).toBe(false);
    });

    it("reads a picker many tools share once, in the reader's words", async () => {
        const offered = await service.deckCatalogue(caller(["chat.use"]), words);
        const mute = offered.find((action) => action.id === "tool.chat_mute");
        expect(mute?.options.find((field) => field.name === "muted")).toMatchObject({
            choices: [
                { value: "true", label: "deck.choice.yes" },
                { value: "false", label: "deck.choice.no" }
            ]
        });
        expect(mute?.options.find((field) => field.name === "conversationId")).toMatchObject({
            choices: [{ value: "c1", label: "general" }]
        });
        expect(calls.filter((call) => call.name === "chat_conversations")).toHaveLength(2);
    });

    it("leaves the tools out of a state read", async () => {
        const { readings } = await service.readDeckStates(
            caller(["chat.use"]),
            [{ key: "k", action: "tool.chat_send", options: {} }],
            words
        );
        expect(readings).toEqual([{ key: "k", state: { tone: "idle" } }]);
        expect(calls).toEqual([]);
    });

    it("never offers a tool the deck's key cannot be granted", async () => {
        const offered = await service.deckCatalogue(caller(["chat.use", "deploy.read"]), words);
        expect(offered.some((action) => action.id.startsWith("tool.databases"))).toBe(false);
        expect(offered.some((action) => action.id === "tool.places_camera_snapshot")).toBe(false);
    });

    it("runs a tool through its own schema with only its own fields", async () => {
        const result = await service.runDeckAction(
            caller(["chat.use"]),
            {
                action: "tool.chat_send",
                options: { conversationId: CONVERSATION, body: "hi", stray: "x" }
            },
            words
        );
        expect(result).toEqual({ ok: true });
        expect(calls).toEqual([
            {
                name: "chat_send",
                input: { conversationId: CONVERSATION, body: "hi" },
                scopes: ["chat.use"]
            }
        ]);
    });

    it("refuses a tool the key may not use, by the same words as any other", async () => {
        const result = await service.runDeckAction(
            caller(["chat.use"]),
            { action: "tool.deploy_restart", options: { service: "web/api" } },
            words
        );
        expect(result).toEqual({ ok: false, message: "deck.errors.unknownAction" });
        expect(calls).toEqual([]);
    });

    it("reads fields from a schema and leaves out a tool no screen can fill", async () => {
        const { toolFields, spokenName, rowsOf, toolInput } =
            await import("@/lib/deck/tool-actions");
        const { toJsonSchema } = await import("@/lib/mcp/json-schema");
        const fields = toolFields(
            toJsonSchema(
                z.object({
                    deviceId: z.string(),
                    mode: z.enum(["cool", "heat"]),
                    level: z.number().min(1).max(100).optional(),
                    on: z.boolean().optional(),
                    tags: z.array(z.string()).optional()
                })
            )
        );
        expect(fields?.map((field) => [field.name, field.type])).toEqual([
            ["deviceId", "choice"],
            ["mode", "choice"],
            ["level", "number"],
            ["on", "choice"]
        ]);
        expect(toolFields(toJsonSchema(z.object({ ids: z.array(z.string()) })))).toBeNull();
        expect(spokenName("maxPlayers")).toBe("Max players");
        expect(rowsOf({ rows: [{ id: "a", title: "Alpha" }, { id: "b" }] })).toEqual([
            { value: "a", label: "Alpha" },
            { value: "b", label: "b" }
        ]);
        const entry = { id: "tool.x", tool: {} as never, fields: fields! };
        expect(toolInput(entry, { deviceId: "d", on: "false", level: "", stray: 1 })).toEqual({
            deviceId: "d",
            on: false
        });
    });
});

describe("a deck connected without a permission its owner holds", () => {
    beforeEach(() => {
        accountScopes = ["home.control", "chat.use"];
        appActions = [lamp];
    });

    it("lists what connecting again would allow, and nothing the owner lacks", async () => {
        const locked = await service.lockedActions(caller(["chat.use"]), words);
        expect(locked).toContainEqual({
            id: lamp.id,
            label: lamp.label["en-US"],
            message: "deck.errors.reconnect"
        });
        expect(locked.some((row) => row.id === "deploy.restart")).toBe(false);
        expect(locked.some((row) => row.id === "chat.send")).toBe(false);
    });

    it("refuses a press with the sentence that says to reconnect", async () => {
        const result = await service.runDeckAction(
            caller(["chat.use"]),
            { action: lamp.id, options: { deviceId: "22222222-2222-4222-8222-222222222222" } },
            words
        );
        expect(result).toEqual({ ok: false, message: "deck.errors.reconnect" });
        expect(calls).toHaveLength(0);
    });

    it("draws the key as Reconnect, and an action the owner lacks as idle", async () => {
        accountScopes = ["home.control"];
        const { readings } = await service.readDeckStates(
            caller([]),
            [
                {
                    key: "a",
                    action: lamp.id,
                    options: { deviceId: "22222222-2222-4222-8222-222222222222" }
                },
                { key: "b", action: "chat.unread", options: {} }
            ],
            words
        );
        expect(readings).toEqual([
            { key: "a", state: { tone: "bad", detail: "deck.status.reconnect" } },
            { key: "b", state: { tone: "idle" } }
        ]);
    });
});
