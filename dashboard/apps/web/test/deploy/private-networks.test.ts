/**
 * Which networks a service joins, read from what is stored, and the pass that
 * keeps this machine's private networks settled.
 *
 * The rule that matters most is the one about existing installs: an environment
 * made before this reads as "shared" and deploys exactly as it did, and so does
 * every environment on a machine whose daemon predates private networks - the
 * daemon would be handed a network it cannot make, and the deploy would fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITED_CAPABILITIES, setCapabilities, type Capabilities } from "@polaris/config";

let environments: unknown[] = [];
let settings: { key: string }[] = [];
const reconciled: string[][] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        environment: { findMany: async () => environments },
        setting: {
            findFirst: async ({ where }: { where: { key: { in: string[] } } }) =>
                settings.find((row) => where.key.in.includes(row.key)) ?? null
        }
    }
}));

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async reconcilePrivateNetworks(keep: string[]) {
            reconciled.push(keep);
            return { kept: keep.length, removed: 0 };
        }
    }
}));

const { environmentNetwork, serviceNetwork } = await import("@polaris/deploy");
const { hasTunnel, networkModeOf, networksForService, reconcilePrivateNetworks, wantedPrivateNetworks } = await import(
    "@/lib/deploy/service-networks"
);

const PROXY = "polaris-proxy";
const LOCAL = { kind: "local", hostId: null, proxyNetwork: PROXY };
const REMOTE = { kind: "host", hostId: "host-1", proxyNetwork: PROXY };

function daemon(privateNetworks: boolean): void {
    const capabilities: Capabilities = { ...LIMITED_CAPABILITIES, edition: "full", deploy: true, privateNetworks };
    setCapabilities(capabilities);
}

function facts(overrides: Partial<Parameters<typeof networksForService>[0]> = {}) {
    return {
        environment: { id: "env-1", networkMode: "environment", layout: "{}" },
        serviceId: "svc-a",
        target: LOCAL,
        published: false,
        routed: false,
        ...overrides
    };
}

beforeEach(() => {
    environments = [];
    settings = [];
    reconciled.length = 0;
    daemon(true);
});

describe("the networks a stored service is deployed onto", () => {
    it("reads anything that is not one of the three modes as shared", () => {
        expect(networkModeOf("links")).toBe("links");
        expect(networkModeOf("")).toBe("shared");
        expect(networkModeOf("isolated")).toBe("shared");
        expect(networkModeOf(null)).toBe("shared");
    });

    it("keeps a shared environment on the proxy network alone, as before", () => {
        const environment = { id: "env-1", networkMode: "shared", layout: "{}" };
        expect(networksForService(facts({ environment, routed: true }))).toEqual([PROXY]);
    });

    it("keeps everything on the proxy network under a daemon that predates private networks", () => {
        daemon(false);
        expect(networksForService(facts())).toEqual([PROXY]);
        // Another server makes them over SSH, whatever this machine's daemon is.
        expect(networksForService(facts({ target: REMOTE }))).toEqual([environmentNetwork("env-1")]);
    });

    it("takes a routed service with a closed port onto the proxy network beside its own", () => {
        expect(networksForService(facts({ routed: true }))).toEqual([PROXY, environmentNetwork("env-1")]);
        // A published port is what this machine's edge dials, so no proxy network.
        expect(networksForService(facts({ routed: true, published: true }))).toEqual([environmentNetwork("env-1")]);
        // A database is never routed.
        expect(networksForService(facts({ serviceId: "db-1" }))).toEqual([environmentNetwork("env-1")]);
    });

    it("joins the networks its canvas links point at in links mode", () => {
        const environment = {
            id: "env-1",
            networkMode: "links",
            layout: JSON.stringify({ pos: {}, links: [{ source: "svc-a", target: "db-1" }] })
        };
        expect(networksForService(facts({ environment }))).toEqual([serviceNetwork("svc-a"), serviceNetwork("db-1")]);
        expect(networksForService(facts({ environment, serviceId: "db-1" }))).toEqual([serviceNetwork("db-1")]);
    });

    it("counts a tunnel of any of the three kinds as a route", async () => {
        expect(await hasTunnel("svc-a")).toBe(false);
        settings = [{ key: "deploy.ntunnel.svc-a.token" }];
        expect(await hasTunnel("svc-a")).toBe(true);
        settings = [{ key: "deploy.ngrok.svc-a" }];
        expect(await hasTunnel("svc-a")).toBe(true);
        settings = [{ key: "deploy.qtunnel.svc-b" }];
        expect(await hasTunnel("svc-a")).toBe(false);
    });
});

describe("settling this machine's private networks", () => {
    it("keeps each isolated environment's network, and each linked service's", async () => {
        environments = [
            { id: "env-1", networkMode: "environment", applications: [{ id: "svc-a" }], databases: [] },
            { id: "env-2", networkMode: "links", applications: [{ id: "svc-b" }], databases: [{ id: "db-1" }] },
            { id: "env-3", networkMode: "nonsense", applications: [{ id: "svc-c" }], databases: [] }
        ];
        const wanted = await wantedPrivateNetworks();
        expect(wanted).toEqual(
            [environmentNetwork("env-1"), serviceNetwork("svc-b"), serviceNetwork("db-1")].sort()
        );
    });

    it("asks the daemon to keep exactly those", async () => {
        environments = [{ id: "env-1", networkMode: "environment", applications: [], databases: [] }];
        expect(await reconcilePrivateNetworks()).toEqual({ kept: 1, removed: 0 });
        expect(reconciled).toEqual([[environmentNetwork("env-1")]]);
    });

    it("leaves a daemon that cannot make them alone", async () => {
        daemon(false);
        expect(await reconcilePrivateNetworks()).toBeNull();
        expect(reconciled).toEqual([]);
    });
});
