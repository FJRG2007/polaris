/**
 * Polaris's own apps as automation event sources: every event has a typed
 * payload the emitter checks, the editor offers its fields, the picker shows an
 * app's events only where the app is, Announce cannot pass for them, and an
 * event reaches only the automations whose runner may see the thing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const emitted: { type: string; input: Record<string, unknown> }[] = [];
const runners = new Map<string, { id: string; isAdmin: boolean } | null>();
const installed = vi.fn(async () => true);
const can = vi.fn(async () => true);

vi.mock("@polaris/db", () => ({
    prisma: {
        automationTrigger: {
            findMany: (...args: unknown[]) => findMany(...args),
            findFirst: async () => null
        }
    }
}));
vi.mock("@/lib/automations/outbox", () => ({
    AUDIENCE_KEY: "audience",
    emitAutomationEvent: async (type: string, input: Record<string, unknown>) => {
        emitted.push({ type, input });
        return "event-1";
    },
    kickIntake: async () => []
}));
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async (automation: { runAsId: string }) =>
        runners.get(automation.runAsId) ?? null
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: () => installed() }));
vi.mock("@/lib/session", () => ({ sessionCan: () => can() }));
vi.mock("@/app/(app)/automations/actions", () => ({}));

import * as core from "@polaris/core";
import * as events from "@/lib/automations/app-events";
import * as catalog from "@/app/(app)/automations/[id]/node-catalog";

const deploy = {
    deploymentId: "dep-1",
    deployableType: "application",
    deployableId: "app-1",
    name: "Shop / web",
    commitSha: "abc123",
    trigger: "push",
    error: null
};

function armed(...ids: string[]) {
    findMany.mockResolvedValue(
        ids.map((id) => ({
            automation: { id, enabled: true, orgId: null, userId: `u-${id}`, runAsId: `u-${id}` }
        }))
    );
}

beforeEach(() => {
    emitted.length = 0;
    runners.clear();
    findMany.mockReset();
    installed.mockResolvedValue(true);
    can.mockResolvedValue(true);
});

describe("app event shapes", () => {
    it("lists every event under an app and checks its payload", () => {
        for (const name of core.APP_EVENT_NAMES)
            expect(core.APP_EVENT_APPS).toContain(core.APP_EVENTS[name].app);
        expect(core.parseAppEventPayload("deploy.succeeded", deploy)).toEqual(deploy);
        expect(core.parseAppEventPayload("deploy.succeeded", { ...deploy, extra: 1 })).toBeNull();
        expect(core.appEventFields("task.completed")).toEqual([
            "taskId",
            "name",
            "spaceId",
            "listId",
            "actorId"
        ]);
        expect(core.appEventFields("door.open")).toEqual([]);
    });

    it("keeps app, NAS and network event names away from Announce", () => {
        const announce = core.CORE_NODE_CONFIGS["core.announce"];
        for (const name of [
            "deploy.failed",
            "chat.message",
            "nas.offline",
            core.PUBLIC_IP_CHANGED_EVENT
        ])
            expect(announce.safeParse({ name, payload: [] }).success).toBe(false);
        expect(announce.safeParse({ name: "order.paid", payload: [] }).success).toBe(true);
    });

    it("offers an app event's fields as references before any sample", () => {
        const graph = {
            ...core.emptyGraph(),
            nodes: [
                {
                    id: "t",
                    type: "core.onEvent",
                    config: { name: "deploy.failed" },
                    position: { x: 0, y: 0 }
                },
                { id: "n", type: "core.stop", config: {}, position: { x: 0, y: 100 } }
            ],
            edges: [{ from: { node: "t", port: "out" }, to: { node: "n" } }]
        } as unknown as core.AutomationGraph;
        const paths = core
            .referenceOptions(graph, "n", {})
            .flatMap((group) => group.options.map((option) => option.path));
        expect(paths).toContain("trigger.payload.error");
        expect(paths).toContain("trigger.payload.deploymentId");
    });
});

describe("picker", () => {
    it("shows an app's events only when the app is passed in", () => {
        const without = catalog
            .catalogGroups({ triggers: true, apps: [] })
            .map((group) => group.id);
        expect(without).not.toContain("game-servers");
        const all = catalog.catalogGroups({
            triggers: true,
            apps: ["game-servers", "deploy", "chat", "tasks"]
        });
        expect(all.find((group) => group.id === "game-servers")!.items.map((i) => i.value)).toEqual(
            [
                "core.onEvent#gameServerStarted",
                "core.onEvent#gameServerStopped",
                "core.onEvent#gameServerCrashed",
                "core.onEvent#playerJoined"
            ]
        );
        for (const group of all)
            for (const item of group.items)
                if (item.preset) {
                    const picked = catalog.pickedNode(item.value);
                    expect(
                        core.CORE_NODE_CONFIGS["core.onEvent"].safeParse(picked?.config).success
                    ).toBe(true);
                }
        const steps = catalog.catalogGroups({ triggers: false, apps: ["deploy"] });
        expect(steps.map((group) => group.id)).not.toContain("deploy");
    });

    it("lists an installable app only when installed, and each app only with its permission", async () => {
        const user = { id: "u", email: "", name: "", isAdmin: false, sessionId: "" };
        expect(await events.eventApps(user)).toEqual([
            "game-servers",
            "deploy",
            "chat",
            "tasks",
            "mail",
            "drive",
            "calendar"
        ]);
        installed.mockResolvedValue(false);
        expect(await events.eventApps(user)).toEqual(["deploy", "chat", "tasks", "mail", "drive"]);
        can.mockResolvedValue(false);
        expect(await events.eventApps(user)).toEqual([]);
    });
});

describe("emitAppEvent", () => {
    const anyone = { key: "dep-1", mayReceive: async () => true };

    it("sends nothing when no automation listens", async () => {
        armed();
        expect(await events.emitAppEvent("deploy.succeeded", deploy, anyone)).toBe(false);
        expect(emitted).toEqual([]);
    });

    it("names only the automations whose runner may see the thing", async () => {
        armed("a1", "a2", "a3");
        runners.set("u-a1", { id: "u-a1", isAdmin: false });
        runners.set("u-a2", { id: "u-a2", isAdmin: false });
        // a3's runner may no longer run anything; a2's may not see this deploy.
        const sent = await events.emitAppEvent(
            "deploy.failed",
            { ...deploy, error: "boom" },
            { key: "dep-1", mayReceive: async (runner) => runner.id === "u-a1" }
        );
        expect(sent).toBe(true);
        expect(emitted).toEqual([
            {
                type: "core.event",
                input: {
                    subjectKey: "deploy.failed",
                    payload: {
                        name: "deploy.failed",
                        payload: { ...deploy, error: "boom" },
                        audience: ["a1"]
                    },
                    dedupeKey: "deploy.failed:dep-1"
                }
            }
        ]);
    });

    it("sends nothing when no runner may see the thing", async () => {
        armed("a1");
        runners.set("u-a1", { id: "u-a1", isAdmin: false });
        const sent = await events.emitAppEvent(
            "chat.message",
            {
                messageId: "m",
                channelId: "c",
                authorId: "u",
                body: "hi",
                threadId: null
            },
            { key: "m", mayReceive: async () => false }
        );
        expect(sent).toBe(false);
        expect(emitted).toEqual([]);
    });

    it("refuses a payload that does not match its shape", async () => {
        armed("a1");
        runners.set("u-a1", { id: "u-a1", isAdmin: true });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const bad = { ...deploy, deploymentId: "" };
        expect(await events.emitAppEvent("deploy.succeeded", bad, anyone)).toBe(false);
        expect(emitted).toEqual([]);
        error.mockRestore();
    });

    it("never throws into the caller", async () => {
        findMany.mockRejectedValue(new Error("db down"));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const task = { taskId: "t", name: "n", spaceId: "s", listId: "l", actorId: null };
        await expect(events.emitAppEvent("task.created", task, anyone)).resolves.toBe(false);
        error.mockRestore();
    });
});
