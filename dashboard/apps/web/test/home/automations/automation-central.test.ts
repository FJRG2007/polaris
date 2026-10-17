/**
 * The Places "run another automation" node in the central engine: it starts the
 * central twin of a Places automation of this house, and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "22222222-2222-4222-8222-222222222222";
const TWIN = "00000000-0000-4000-8000-000000000042";
const STRANGER = "00000000-0000-4000-8000-000000000099";

const state = vi.hoisted(() => ({
    legacy: [] as { id: string; installedAppId: string }[],
    central: new Map<string, string>(),
    fired: [] as { automationId: string }[]
}));

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        installedApp: {
            findFirst: async () => ({ id: INSTALL, ownerId: "owner", name: "Home" })
        },
        placeAutomation: {
            findFirst: async (args: { where: { id: string; installedAppId: string } }) =>
                state.legacy.find(
                    (row) =>
                        row.id === args.where.id && row.installedAppId === args.where.installedAppId
                ) ?? null
        }
    }
}));

vi.mock("@polaris-app/places/src/lib/automation-runtime", () => ({
    automationEngine: () => ({}),
    mayOperate: async () => true
}));

vi.mock("@polaris/app-host", async (original) => {
    const real = (await original()) as { host: object };
    const { StepError, StepRefusal } = await import("@/lib/automations/types");
    const automations = {
        StepError,
        StepRefusal,
        automationForLegacy: async (ref: string) => state.central.get(ref) ?? null,
        fireAppTrigger: async (input: { automationId: string }) => {
            state.fired.push(input);
            return true;
        }
    };
    return {
        ...real,
        host: new Proxy(real.host, {
            get: (target, key) =>
                key === "automations"
                    ? automations
                    : (target as Record<string | symbol, unknown>)[key]
        })
    };
});

const central = await import("@polaris-app/places/src/lib/automation-central");

const runNode = central.placesAutomationNodes().find((node) => node.type === "home.action.run")!;

function io() {
    return {
        actor: { id: "owner" },
        automationId: "11111111-1111-4111-8111-111111111111",
        depth: 0,
        idempotencyKey: "step-1"
    };
}

function run(automationId: string) {
    return runNode.run!(
        { kind: "run", automationId, placeId: "place-1" } as never,
        { automation: { name: "Caller" } } as never,
        io() as never
    );
}

beforeEach(() => {
    state.legacy = [];
    state.central = new Map();
    state.fired = [];
});

describe("the run node", () => {
    it("starts the central twin of a Places automation of this house", async () => {
        state.legacy = [{ id: "a2", installedAppId: INSTALL }];
        state.central.set("place:a2", TWIN);
        expect(await run("a2")).toEqual({ output: { started: true } });
        expect(state.fired.map((each) => each.automationId)).toEqual([TWIN]);
    });

    it("starts nothing for one of this house not moved yet", async () => {
        state.legacy = [{ id: "a2", installedAppId: INSTALL }];
        expect(await run("a2")).toEqual({ output: { started: false } });
        expect(state.fired).toEqual([]);
    });

    it("refuses any other automation id, of another house or of the central list", async () => {
        state.legacy = [{ id: "a3", installedAppId: "33333333-3333-4333-8333-333333333333" }];
        state.central.set("place:a3", TWIN);
        await expect(run("a3")).rejects.toMatchObject({ code: "callForbidden" });
        await expect(run(STRANGER)).rejects.toMatchObject({ code: "callForbidden" });
        expect(state.fired).toEqual([]);
    });
});
