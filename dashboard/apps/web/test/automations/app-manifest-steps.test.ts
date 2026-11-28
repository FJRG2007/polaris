/**
 * Automation steps an app declares in its manifest: registered from the
 * published catalogue under the app, offered in the picker under the app's
 * name, their settings checked by the declared fields, run only for a run-as
 * account holding the step's permission, and their answer checked against the
 * declared output. A step outside the app's id or behind another app's
 * permission is never registered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));
const state = vi.hoisted(() => ({ user: { id: "u1", isAdmin: false } as { id: string; isAdmin: boolean } | null, can: true }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: async () => state.user }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.can }));

import * as core from "@polaris/core";
import { HOST_API } from "@polaris/app-host/version";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { catalogGroups } from "@/app/(app)/automations/[id]/node-catalog";
import { appStepViews, manifestStepNodes } from "@/lib/automations/app-steps";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";

const step = (over: Record<string, unknown> = {}) => ({
    type: "bakery.action.bake",
    label: { "en-US": "Bake a loaf", "es-ES": "Hornear una barra" },
    description: { "en-US": "Puts a loaf in the oven." },
    permission: "bakery.use",
    fields: [
        { key: "loafId", kind: "id", label: { "en-US": "Loaf" }, required: true },
        { key: "grams", kind: "number", label: { "en-US": "Grams" }, min: 100, max: 2000 },
        {
            key: "oven",
            kind: "choice",
            label: { "en-US": "Oven" },
            options: [
                { value: "left", label: { "en-US": "Left" } },
                { value: "right", label: { "en-US": "Right" } }
            ]
        }
    ],
    output: { loafId: "id", minutes: "number" },
    ...over
});

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    name: { "en-US": "Bakery", "es-ES": "Panaderia" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    permissions: ["bakery.use"],
    permissionDefs: [{ key: "bakery.use", label: { "en-US": "Take orders" } }],
    automationSteps: [
        step(),
        // Behind another app's permission, and outside its own id: both left out.
        step({ type: "bakery.action.borrow", permission: "deploy.manage" }),
        step({ type: "other.action.bake" })
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, locale)
    );

const io = () => ({ actor: { id: "u1", isAdmin: false }, recordInput: vi.fn() }) as never;
const context = { trigger: { loafId: "l-1" }, automation: { id: "a1", name: "Bake" } } as never;

beforeEach(() => {
    state.user = { id: "u1", isAdmin: false };
    state.can = true;
});
afterEach(() => deliver([]));

describe("a manifest's automation steps", () => {
    it("registers only the app's own steps, behind its own permission, in the reader's language", () => {
        deliver([bakery], "es-ES");
        expect(core.appSteps().map((one) => one.type)).toEqual(["bakery.action.bake"]);
        expect(core.appStep("bakery.action.bake")).toMatchObject({ app: "bakery", appName: "Panaderia", label: "Hornear una barra" });
        deliver([]);
        expect(core.appStep("bakery.action.bake")).toBeNull();
    });

    it("checks the settings against the declared fields", () => {
        deliver([bakery]);
        const schema = core.appStepConfigSchema(core.appStep("bakery.action.bake")!);
        expect(schema.safeParse({ loafId: "l-1", grams: 500, oven: "left" }).success).toBe(true);
        expect(schema.safeParse({ grams: 500 }).success).toBe(false);
        expect(schema.safeParse({ loafId: "l-1", grams: 50 }).success).toBe(false);
        expect(schema.safeParse({ loafId: "l-1", oven: "middle" }).success).toBe(false);
        expect(schema.safeParse({ loafId: "l-1", extra: 1 }).success).toBe(false);
    });

    it("offers them in the picker under the app, only to an account holding the permission", async () => {
        deliver([bakery]);
        const views = await appStepViews({ id: "u1" } as never, async () => true);
        expect(views).toEqual([expect.objectContaining({ type: "bakery.action.bake", appName: "Bakery", output: ["loafId", "minutes"] })]);
        const groups = catalogGroups({ triggers: false, steps: true, apps: [], appSteps: views });
        expect(groups.find((group) => group.id === "bakery")?.items.map((item) => item.type)).toEqual(["bakery.action.bake"]);
        state.can = false;
        expect(await appStepViews({ id: "u1" } as never, async () => true)).toEqual([]);
        state.can = true;
        expect(await appStepViews({ id: "u1" } as never, async () => false)).toEqual([]);
    });
});

describe("running a manifest's step", () => {
    it("hands the app the checked settings and returns its declared answer", async () => {
        deliver([bakery]);
        const bake = vi.fn(async () => ({ output: { loafId: "l-1", minutes: 40 } }));
        const [node] = manifestStepNodes("bakery", async () => ({ "bakery.action.bake": bake }));
        expect(node?.type).toBe("bakery.action.bake");
        expect(await node!.run!({ loafId: "l-1" }, context, io())).toEqual({ output: { loafId: "l-1", minutes: 40 } });
        expect(bake).toHaveBeenCalledWith({ loafId: "l-1" }, { actorId: "u1", automationId: "a1", trigger: { loafId: "l-1" } });
    });

    it("is refused for a runner without the permission, and the app is never asked", async () => {
        deliver([bakery]);
        const bake = vi.fn();
        const [node] = manifestStepNodes("bakery", async () => ({ "bakery.action.bake": bake }));
        state.can = false;
        await expect(node!.run!({ loafId: "l-1" }, context, io())).rejects.toMatchObject({ name: "StepRefusal", code: "appStepForbidden" });
        state.user = null;
        await expect(node!.run!({ loafId: "l-1" }, context, io())).rejects.toMatchObject({ code: "runAsGone" });
        expect(bake).not.toHaveBeenCalled();
    });

    it("says the app's refusal, a failure and an answer off its declared output apart", async () => {
        deliver([bakery]);
        const answers = [
            async () => ({ refused: "The oven is off" }),
            async () => {
                throw new Error("database password in here");
            },
            async () => ({ output: { loafId: "l-1", minutes: "forty" } }),
            async () => ({ output: { loafId: "l-1", minutes: 40, secret: "x" } })
        ];
        const codes: unknown[] = [];
        for (const answer of answers) {
            const [node] = manifestStepNodes("bakery", async () => ({ "bakery.action.bake": answer as never }));
            await node!.run!({ loafId: "l-1" }, context, io()).catch((caught: { code: string; output?: unknown }) =>
                codes.push([caught.code, caught.output])
            );
        }
        expect(codes).toEqual([
            ["appStepRefused", { said: "The oven is off" }],
            ["appStepFailed", undefined],
            ["appStepAnswer", undefined],
            ["appStepAnswer", undefined]
        ]);
    });

    it("needs the app's handlers: none, and the step is not a node", async () => {
        deliver([bakery]);
        expect(manifestStepNodes("bakery", undefined)).toEqual([]);
        const [node] = manifestStepNodes("bakery", async () => ({}));
        await expect(node!.run!({ loafId: "l-1" }, context, io())).rejects.toMatchObject({ code: "appMissing" });
    });
});
