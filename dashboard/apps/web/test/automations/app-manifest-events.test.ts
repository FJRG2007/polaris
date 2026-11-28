/**
 * Events an app declares in its manifest, as automation triggers: offered in
 * the picker under the app's name only to an account holding the event's
 * permission (one of the app's own), picked as an "On event" trigger on that
 * name, their declared fields offered to later steps, and named on a run's
 * screen in the reader's language without the editor having been opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ can: true, locale: "en-US", apps: [] as unknown[] }));
vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/automations/outbox", () => ({ AUDIENCE_KEY: "audience", emitAutomationEvent: async () => null, kickIntake: async () => [] }));
vi.mock("@/lib/automations/runner", () => ({ automationRunner: async () => null }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => state.can }));
vi.mock("@/lib/apps/runtime-catalog", async (original) => {
    const actual = await original<typeof import("@/lib/apps/runtime-catalog")>();
    const schema = await import("@/lib/apps/runtime-catalog-schema");
    return {
        ...actual,
        heldRuntimeAppViews: (locale: string) =>
            schema.runtimeViews(catalogOf(state.apps), actual.KNOWN_PERMISSIONS, locale)
    };
});

import * as core from "@polaris/core";
import { HOST_API } from "@polaris/app-host/version";
import { appWordsFor } from "@/lib/automations/app-words";
import { appEventViews } from "@/lib/automations/app-events";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";
import { appEventLabel, appStepView } from "@/app/(app)/automations/app-step-words";
import { catalogGroups, pickedNode } from "@/app/(app)/automations/[id]/node-catalog";

function catalogOf(apps: unknown[]) {
    return readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps });
}

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
    events: [
        {
            name: "bakery.loaf-baked",
            label: { "en-US": "Loaf baked", "es-ES": "Barra horneada" },
            permission: "bakery.use",
            fields: { loafId: "id", grams: "number" }
        },
        // Behind another app's permission: it fires, but nobody is offered it.
        { name: "bakery.borrowed", label: { "en-US": "Borrowed" }, permission: "deploy.manage", fields: {} },
        // No permission and no place on the rail: offered to nobody either.
        { name: "bakery.quiet", label: { "en-US": "Quiet" }, fields: {} }
    ],
    automationSteps: [
        {
            type: "bakery.action.bake",
            label: { "en-US": "Bake a loaf", "es-ES": "Hornear una barra" },
            description: { "en-US": "Puts a loaf in the oven.", "es-ES": "Mete una barra en el horno." },
            permission: "bakery.use",
            fields: [],
            output: {}
        }
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") => {
    state.apps = apps;
    registerRuntimeApps(runtimeViews(catalogOf(apps), KNOWN_PERMISSIONS, locale));
};

const graph = (nodes: { id: string; type: string; config: unknown }[]) =>
    ({
        ...core.emptyGraph(),
        nodes: nodes.map((node, index) => ({ ...node, position: { x: 0, y: index * 100 } })),
        edges: nodes.slice(1).map((node, index) => ({ from: { node: nodes[index]!.id, port: "out" }, to: { node: node.id } }))
    }) as unknown as core.AutomationGraph;

beforeEach(() => {
    state.can = true;
});
afterEach(() => deliver([]));

describe("a manifest's events as triggers", () => {
    it("registers each under the app, gated by one of the app's own permissions", () => {
        deliver([bakery], "es-ES");
        expect(core.registeredAppEvents()).toEqual([
            { name: "bakery.loaf-baked", app: "bakery", appName: "Panaderia", label: "Barra horneada", permission: "bakery.use", fields: ["loafId", "grams"] },
            expect.objectContaining({ name: "bakery.borrowed", permission: null }),
            expect.objectContaining({ name: "bakery.quiet", permission: null })
        ]);
    });

    it("gates an event without a permission of its own like the app's place on the rail", () => {
        deliver([{ ...bakery, nav: { category: "work", permission: "bakery.use" } }]);
        expect(core.registeredAppEvents().find((event) => event.name === "bakery.quiet")?.permission).toBe("bakery.use");
    });

    it("offers only those this account may build on, under the app's name in the picker", async () => {
        deliver([bakery]);
        const views = await appEventViews({ id: "u1" } as never, async () => true);
        expect(views).toEqual([
            { name: "bakery.loaf-baked", app: "bakery", appName: "Bakery", label: "Loaf baked", fields: ["loafId", "grams"] }
        ]);
        const group = catalogGroups({ triggers: true, apps: [], appEvents: views }).find((one) => one.id === "bakery");
        expect(group?.items).toEqual([{ value: "core.onEvent#bakery.loaf-baked", type: "core.onEvent", appEvent: "bakery.loaf-baked" }]);
        // Not where only steps are offered.
        expect(catalogGroups({ triggers: false, steps: true, apps: [], appEvents: views }).some((one) => one.id === "bakery")).toBe(false);
        state.can = false;
        expect(await appEventViews({ id: "u1" } as never, async () => true)).toEqual([]);
        state.can = true;
        expect(await appEventViews({ id: "u1" } as never, async () => false)).toEqual([]);
    });

    it("lands as an On event trigger on that name, whose fields later steps can refer to", () => {
        deliver([bakery]);
        const picked = pickedNode("core.onEvent#bakery.loaf-baked");
        expect(picked).toEqual({ type: "core.onEvent", config: { name: "bakery.loaf-baked", outcomes: [] } });
        expect(core.CORE_NODE_CONFIGS["core.onEvent"].safeParse(picked?.config).success).toBe(true);
        const paths = core
            .referenceOptions(graph([{ id: "t", ...picked! }, { id: "n", type: "core.stop", config: {} }]), "n", {})
            .flatMap((group) => group.options.map((option) => option.path));
        expect(paths).toEqual(expect.arrayContaining(["trigger.payload.loafId", "trigger.payload.grams"]));
        // A preset name that is not one still names nothing.
        expect(pickedNode("core.onEvent#nothingHere")).toBeNull();
    });
});

describe("naming an app's step and trigger on a run", () => {
    it("sends the words of what the run's graph uses, in the reader's language", () => {
        deliver([bakery]);
        const run = graph([
            { id: "t", type: "core.onEvent", config: { name: "bakery.loaf-baked" } },
            { id: "s", type: "bakery.action.bake", config: {} }
        ]);
        const words = appWordsFor(run, "es-ES");
        expect(words.events).toEqual([{ name: "bakery.loaf-baked", label: "Barra horneada" }]);
        expect(words.steps).toEqual([
            expect.objectContaining({ type: "bakery.action.bake", appName: "Panaderia", label: "Hornear una barra" })
        ]);
        expect(appWordsFor(graph([{ id: "t", type: "core.manual", config: {} }]), "es-ES")).toEqual({ steps: [], events: [] });
        expect(appWordsFor(null, "en-US")).toEqual({ steps: [], events: [] });
    });

    it("names them from the registered manifests when no screen sent words", () => {
        deliver([bakery], "es-ES");
        expect(appStepView("bakery.action.bake")).toMatchObject({ label: "Hornear una barra", appName: "Panaderia" });
        expect(appEventLabel("bakery.loaf-baked")).toBe("Barra horneada");
        expect(appStepView("bakery.action.missing")).toBeNull();
        expect(appEventLabel("deploy.failed")).toBeNull();
    });
});
