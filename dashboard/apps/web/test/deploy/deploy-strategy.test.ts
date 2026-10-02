/**
 * What a deploy does to the running version, decided once and read by both the
 * deploy and the screen: a change-over with no gap where two copies can run at
 * once, else a restart with every reason. And the networks of the operator's own a
 * service joins, validated by the one schema the form and the server share.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const releases = await import("@/lib/deploy/releases");
const { externalNetworksSchema } = await import("@/lib/deploy/external-networks-schema");
const { externalNetworkPlan, storedExternalNetworks } = await import(
    "@/lib/deploy/external-networks"
);

const plain = {
    id: "app-1",
    keepReleases: false,
    publishPort: false,
    sourceType: "github",
    sourceConfig: "{}",
    volumes: [] as { name: string }[],
    overlapVolumes: false,
    target: { kind: "local", runtime: "compose" }
};
const routed = { followsPushedRoutes: true };
const hostPort = () => 24_123;

describe("how a deploy replaces what runs", () => {
    it("changes over with no gap for a routed service with nothing against it", () => {
        expect(releases.deployStrategy(plain, routed, hostPort)).toEqual({ mode: "overlap" });
    });

    it("restarts a service that binds a host port, naming the port", () => {
        expect(releases.deployStrategy({ ...plain, publishPort: true }, routed, hostPort)).toEqual({
            mode: "restart",
            reasons: [{ code: "hostPort", port: 24_123, protocol: "tcp" }]
        });
        // A game server's own port and its second door.
        const game = {
            ...plain,
            sourceType: "image",
            publishPort: true,
            sourceConfig: JSON.stringify({
                hostPort: 25565,
                extraPorts: [{ host: 19132, container: 19132, protocol: "udp" }]
            })
        };
        expect(releases.deployStrategy(game, routed, hostPort)).toEqual({
            mode: "restart",
            reasons: [
                { code: "hostPort", port: 25565, protocol: "tcp" },
                { code: "hostPort", port: 19132, protocol: "udp" }
            ]
        });
    });

    it("restarts a service with volumes unless it was allowed to share them", () => {
        const withData = { ...plain, volumes: [{ name: "uploads" }] };
        expect(releases.deployStrategy(withData, routed)).toEqual({
            mode: "restart",
            reasons: [{ code: "volumes", names: ["uploads"] }]
        });
        expect(releases.deployStrategy({ ...withData, overlapVolumes: true }, routed)).toEqual({
            mode: "overlap"
        });
        expect(releases.runsCutover({ ...withData, overlapVolumes: true }, routed)).toBe(true);
        expect(releases.runsCutover(withData, routed)).toBe(false);
    });

    it("never lets two swarm tasks share a volume, whatever the setting", () => {
        const swarm = { ...plain, target: { kind: "local", runtime: "swarm" } };
        expect(releases.deployStrategy(swarm, routed)).toEqual({ mode: "swarm" });
        expect(
            releases.deployStrategy(
                { ...swarm, volumes: [{ name: "data" }], overlapVolumes: true },
                routed
            )
        ).toEqual({
            mode: "restart",
            reasons: [{ code: "volumes", names: ["data"] }]
        });
    });

    it("says why for an owner's compose file and an edge that takes no routes", () => {
        expect(releases.deployStrategy({ ...plain, sourceType: "compose" }, routed)).toEqual({
            mode: "restart",
            reasons: [{ code: "compose" }]
        });
        const remote = { ...plain, target: { kind: "host", runtime: "compose" } };
        expect(releases.deployStrategy(remote, { followsPushedRoutes: false })).toEqual({
            mode: "restart",
            reasons: [{ code: "edge" }]
        });
    });

    it("runs kept releases side by side on this host, and says why not elsewhere", () => {
        expect(releases.deployStrategy({ ...plain, keepReleases: true }, routed)).toEqual({
            mode: "kept"
        });
        expect(
            releases.deployStrategy(
                { ...plain, keepReleases: true, target: { kind: "host", runtime: "compose" } },
                routed
            )
        ).toEqual({ mode: "restart", reasons: [{ code: "history" }] });
    });
});

describe("the container the edge dials", () => {
    const base = releases.serviceRef("acme", "shop", "app-1");

    it("is the change-over release's own name, never the alias every release answers to", () => {
        const name = releases.edgeDialName(base, { id: "dep-2", cutover: true });
        expect(name).toBe(releases.releaseRef(base, releases.releaseMarker({ id: "dep-2" })).name);
        expect(name).not.toBe(base.name);
    });

    it("is the service's own name for a release deployed in place", () => {
        expect(releases.edgeDialName(base, { id: "dep-2", cutover: false })).toBe(base.name);
        expect(releases.edgeDialName(base, null)).toBe(base.name);
    });
});

describe("networks of the operator's own", () => {
    it("takes several names on one network - the one the service is called and the one a client insists on", () => {
        const parsed = externalNetworksSchema.parse([
            { name: "app_network", aliases: ["dymo-api", " DymoAPI ", "dymo-api"] }
        ]);
        expect(parsed).toEqual([{ name: "app_network", aliases: ["dymo-api", "dymoapi"] }]);
        expect(externalNetworkPlan(parsed)).toEqual({
            networks: ["app_network"],
            aliases: { app_network: ["dymo-api", "dymoapi"] }
        });
    });

    it("refuses Docker's own networks and Polaris's, and names that are not one DNS label", () => {
        for (const name of [
            "host",
            "bridge",
            "polaris_default",
            "polaris-proxy",
            "-bad",
            "has space"
        ]) {
            expect(externalNetworksSchema.safeParse([{ name, aliases: [] }]).success).toBe(false);
        }
        for (const alias of ["dymo_api", "-api", "api-", "a.b"]) {
            expect(
                externalNetworksSchema.safeParse([{ name: "app_network", aliases: [alias] }])
                    .success
            ).toBe(false);
        }
        expect(
            externalNetworksSchema.safeParse([
                { name: "app_network", aliases: [] },
                { name: "app_network", aliases: [] }
            ]).success
        ).toBe(false);
    });

    it("reads a stored list that no longer parses as none, rather than joining something half-read", () => {
        expect(storedExternalNetworks("not json")).toEqual([]);
        expect(storedExternalNetworks('[{"name":"polaris_default"}]')).toEqual([]);
        expect(storedExternalNetworks('[{"name":"app_network","aliases":["api"]}]')).toEqual([
            { name: "app_network", aliases: ["api"] }
        ]);
    });
});
