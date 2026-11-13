/**
 * Every action of the device mesh refuses while it is switched off, whoever asks,
 * before anything reaches the control server - the screens are hidden then, and a
 * hand-made request is answered the same way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mesh: false, reached: [] as string[] }));

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "fixture-user", isAdmin: true }),
    requireAdmin: async () => ({ id: "fixture-user", isAdmin: true })
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/apps/catalog", () => ({ findApp: vi.fn() }));
vi.mock("@/lib/apps/install-service", () => ({ installApp: vi.fn() }));
vi.mock("@/lib/apps/install-defaults", () => ({ defaultInstallInput: vi.fn() }));
/** A stand-in for each service call the actions make, which records being reached. */
function reaching(names: readonly string[], answer: unknown): Record<string, () => Promise<unknown>> {
    return Object.fromEntries(
        names.map((name) => [
            name,
            async () => {
                state.reached.push(name);
                return answer;
            }
        ])
    );
}

vi.mock("@/lib/vpn/service", () => {
    class VpnRefusal extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    return {
        VpnRefusal,
        requireMesh: async () => {
            if (!state.mesh) throw new VpnRefusal("meshOff");
        },
        ...reaching(
            [
                "checkHostname",
                "createDeviceKey",
                "hostnameZones",
                "listDeviceKeys",
                "listDevices",
                "mayJoin",
                "registerDevice",
                "removeDevice",
                "removeVpn",
                "renameDevice",
                "revokeDeviceKey",
                "setDeviceRoutes",
                "setMesh",
                "turnOff",
                "turnOn",
                "vpnStatus"
            ],
            []
        )
    };
});
vi.mock("@/lib/vpn/network-service", () => ({
    canRunGateways: () => true,
    ...reaching(
        ["createNetwork", "firstNetworkServer", "listNetworks", "removeNetwork", "retryGateway", "updateNetwork"],
        { network: { id: "fixture" } }
    )
}));

const meshActions = await import("@/app/(app)/vpn/actions");
const networkActions = await import("@/app/(app)/vpn/networks/actions");

/** The actions that are not the device mesh's own: installing the VPN, and the
 *  switch that turns the mesh on. */
const NOT_MESH = new Set(["installVpnAppAction", "setVpnMeshAction"]);

const ACTIONS = Object.entries({ ...meshActions, ...networkActions }).filter(
    ([name, value]) => typeof value === "function" && !NOT_MESH.has(name)
) as [string, (input?: unknown, more?: unknown) => Promise<{ error?: string }>][];

beforeEach(() => {
    state.mesh = false;
    state.reached = [];
});

describe("device mesh actions while it is off", () => {
    it("covers every mesh action", () => {
        expect(ACTIONS.length).toBeGreaterThanOrEqual(18);
    });

    it.each(ACTIONS)("%s refuses and reaches nothing", async (_name, action) => {
        const result = await action({ subdomain: "vpn" }, {});
        expect(result.error).toBe("errors.meshOff");
        expect(state.reached).toEqual([]);
    });

    it("lets them through once it is on", async () => {
        state.mesh = true;
        const result = await meshActions.listVpnDevicesAction();
        expect(result.error).toBeUndefined();
        expect(state.reached.length).toBeGreaterThan(0);
    });
});
