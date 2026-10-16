/**
 * Which host ports close so the edge is the only way in, and which stay open.
 *
 * A port nobody chose, on a service the edge answers for, closes. A port the
 * owner opened or pinned, a service with no domain, an installed app or the mail
 * server Polaris reaches on its port, and a service on another server keep theirs.
 * The firewall screen lists what still answers round the edge, and says which of
 * those it cannot close.
 */

import { describe, expect, it, vi } from "vitest";

const hostGroupMembers = vi.fn(async () => [{ hostId: "host-a" }, { hostId: "host-b" }]);
vi.mock("@polaris/db", () => ({
    prisma: { hostGroupMember: { findMany: hostGroupMembers } }
}));

const directPort = await import("../../src/lib/deploy/direct-port");
const { hostPortForApp } = await import("../../src/lib/deploy/host-port");

type Facts = Parameters<typeof directPort.closesDirectPort>[0];

const LEFT_BY_DEFAULT: Facts = {
    local: true,
    publishPort: true,
    chosen: false,
    pinned: false,
    reachedOnPort: false,
    routed: true
};

describe("closesDirectPort", () => {
    it("closes a port left open by the old default on a service with a domain", () => {
        expect(directPort.closesDirectPort(LEFT_BY_DEFAULT)).toBe(true);
    });

    it.each<[string, Partial<Facts>]>([
        ["the owner opened it on purpose", { chosen: true }],
        ["the owner pinned the host port (a game server's 25565)", { pinned: true }],
        ["the service has no domain, so the port is how it is reached", { routed: false }],
        ["Polaris or the app's client reaches it on the port", { reachedOnPort: true }],
        ["it runs on another server", { local: false }],
        ["the port is already closed", { publishPort: false }]
    ])("keeps it when %s", (_why, change) => {
        expect(directPort.closesDirectPort({ ...LEFT_BY_DEFAULT, ...change })).toBe(false);
    });
});

describe("pinnedHostPort", () => {
    it("reads a pinned port, and nothing else", () => {
        expect(directPort.pinnedHostPort('{"hostPort":25565}')).toBe(25565);
        expect(directPort.pinnedHostPort('{"hostPort":"25565"}')).toBeNull();
        expect(directPort.pinnedHostPort("{}")).toBeNull();
        expect(directPort.pinnedHostPort("not json")).toBeNull();
    });
});

function service(
    id: string,
    name: string,
    facts: Partial<Facts> = {},
    extra: Partial<{ hostPort: number | null; running: boolean; currentDeploymentId: string }> = {}
) {
    return {
        id,
        name,
        ownerId: "owner",
        currentDeploymentId: extra.currentDeploymentId ?? `${id}-release`,
        hostPort: extra.hostPort ?? null,
        running: extra.running ?? true,
        facts: { ...LEFT_BY_DEFAULT, ...facts }
    };
}

describe("directAccessOf", () => {
    it("names every routed service still on a host port, with its address", () => {
        const found = directPort.directAccessOf(
            [
                service("b", "web"),
                service("a", "api", { chosen: true }),
                service("c", "game", { reachedOnPort: true }, { hostPort: 25565 })
            ],
            new Set(),
            "203.0.113.7"
        );
        expect(found).toEqual([
            { applicationId: "a", name: "api", address: `203.0.113.7:${hostPortForApp("a")}`, held: null },
            { applicationId: "c", name: "game", address: "203.0.113.7:25565", held: "installed" },
            { applicationId: "b", name: "web", address: `203.0.113.7:${hostPortForApp("b")}`, held: null }
        ]);
    });

    it("leaves out what the edge does not answer for, what is closed and what is not running", () => {
        expect(
            directPort.directAccessOf(
                [
                    service("a", "no domain", { routed: false }),
                    service("b", "closed", { publishPort: false }),
                    service("c", "remote", { local: false }),
                    service("d", "stopped", {}, { running: false })
                ],
                new Set(),
                null
            )
        ).toEqual([]);
    });

    it("reports a kept release on its own port, which this screen cannot close", () => {
        const [entry] = directPort.directAccessOf(
            [service("a", "web", { publishPort: false }, { currentDeploymentId: "release-1" })],
            new Set(["release-1"]),
            null
        );
        expect(entry).toEqual({
            applicationId: "a",
            name: "web",
            address: String(hostPortForApp("release-1")),
            held: "keptRelease"
        });
    });
});

describe("servicesOfScope", () => {
    it("guards no deployed service for Polaris's own scope", async () => {
        expect(await directPort.servicesOfScope("polaris", "", null)).toBeNull();
    });

    it("covers every service for the instance-wide scope", async () => {
        expect(await directPort.servicesOfScope("global", "", null)).toEqual({});
    });

    it("narrows an owned scope to the reader's own services", async () => {
        expect(await directPort.servicesOfScope("server", "host-a", "owner-1")).toEqual({
            AND: [{ environment: { project: { ownerId: "owner-1" } } }, { target: { hostId: "host-a" } }]
        });
        expect(await directPort.servicesOfScope("server-group", "group-1", "owner-1")).toEqual({
            AND: [
                { environment: { project: { ownerId: "owner-1" } } },
                { target: { hostId: { in: ["host-a", "host-b"] } } }
            ]
        });
        expect(await directPort.servicesOfScope("application", "app-1", "owner-1")).toEqual({
            AND: [{ environment: { project: { ownerId: "owner-1" } } }, { id: "app-1" }]
        });
    });
});
