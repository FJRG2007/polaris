/**
 * Clean-up on a server shared with containers Polaris did not start.
 *
 * The ordinary sweep runs `docker system prune`, which removes every stopped
 * container and every network nothing is attached to at that moment - on a host
 * that ran somebody's services before Polaris came, their stopped container and
 * the network their services find each other on. A shared host is swept for images
 * and build cache only, a host is found to be shared from what runs on it the
 * first time it is asked, and the reclaim a deploy runs over SSH uses the same
 * decision.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { host, said, ran } = vi.hoisted(() => ({
    host: { sharedHost: null as boolean | null },
    said: { listing: "" as string | null, finished: true },
    ran: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findUnique: vi.fn(async () => host),
            findFirst: vi.fn(async () => host),
            update: vi.fn(async (args: { data: { sharedHost: boolean } }) =>
                Object.assign(host, args.data)
            )
        }
    }
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnectionUnscoped: vi.fn(async () => ({
        id: "host-1",
        address: "203.0.113.7",
        port: 22,
        username: "ops",
        auth: {}
    }))
}));
vi.mock("@/lib/connection-pool", () => ({
    borrowSsh: vi.fn(async () => ({ client: {}, release: () => undefined }))
}));
vi.mock("@polaris/ssh", () => ({
    execCommand: vi.fn(
        async (_client: unknown, command: string, sinks: { onStdout: (chunk: Buffer) => void }) => {
            ran.push(command);
            if (command.includes("docker ps -a")) {
                if (said.listing === null) throw new Error("connection refused");
                sinks.onStdout(Buffer.from(said.listing));
                if (said.finished) sinks.onStdout(Buffer.from("polaris-listed|\n"));
            }
            return { code: 0 };
        }
    )
}));

const space = await import("@/lib/deploy/server-space");

beforeEach(() => {
    host.sharedHost = null;
    said.listing = "";
    said.finished = true;
    ran.length = 0;
});

describe("the careful sweep", () => {
    it("removes images and build cache only - never a container, a network or a volume", () => {
        const sweep = space.pruneCommandFor(true);
        expect(sweep).toContain("docker image prune -af --filter 'label!=polaris.release'");
        expect(sweep).toContain("docker builder prune -af");
        for (const forbidden of [
            "system prune",
            "network prune",
            "container prune",
            "volume prune",
            "nerdctl system"
        ]) {
            expect(sweep).not.toContain(forbidden);
        }
    });

    it("is the ordinary sweep on a server only Polaris uses", () => {
        expect(space.pruneCommandFor(false)).toBe(space.PRUNE_EVERY_ENGINE);
    });
});

describe("telling whether a server is shared", () => {
    it("finds containers Polaris did not start, stopped ones included", () => {
        const listing = [
            "polaris-1a2b-shop|polaris-1a2b3c4d",
            "polaris-traefik|",
            "payments-api|payments",
            "old-cron|"
        ].join("\n");
        expect(space.foreignContainers(listing)).toEqual(["payments-api", "old-cron"]);
        expect(space.foreignContainers("polaris-1a2b-shop|polaris-1a2b3c4d\n")).toEqual([]);
    });

    it("decides once from what runs there, and keeps the answer", async () => {
        said.listing = "payments-api|payments\n";
        expect(await space.isSharedHost("host-1")).toBe(true);
        expect(host.sharedHost).toBe(true);
        said.listing = "";
        expect(await space.isSharedHost("host-1")).toBe(true);
        expect(ran.filter((command) => command.includes("docker ps -a"))).toHaveLength(1);
    });

    it("takes a server only Polaris uses as not shared, and looks again next time", async () => {
        said.listing = "polaris-1a2b-shop|polaris-1a2b3c4d\n";
        expect(await space.isSharedHost("host-1")).toBe(false);
        expect(host.sharedHost).toBeNull();
        said.listing = "polaris-1a2b-shop|polaris-1a2b3c4d\nthe-operators-db|\n";
        expect(await space.isSharedHost("host-1")).toBe(true);
        expect(host.sharedHost).toBe(true);
    });

    it("never reads a listing that did not finish as a server nobody else uses", async () => {
        said.finished = false;
        expect(await space.isSharedHost("host-1")).toBe(true);
        expect(host.sharedHost).toBeNull();
    });

    it("is careful with a server it cannot ask, and asks again next time", async () => {
        said.listing = null;
        expect(await space.isSharedHost("host-1")).toBe(true);
        expect(host.sharedHost).toBeNull();
    });

    it("follows the operator's own answer over what it finds", async () => {
        host.sharedHost = false;
        said.listing = "payments-api|payments\n";
        expect(await space.isSharedHost("host-1")).toBe(false);
    });
});

describe("a reclaim on a shared server", () => {
    it("runs the careful sweep, so a stopped container and an empty network of the operator's survive it", async () => {
        host.sharedHost = true;
        await space.reclaimServerSpace("host-1");
        const sweeps = ran.filter((command) => command.includes("prune"));
        expect(sweeps).toEqual([space.PRUNE_SHARED_HOST]);
        expect(sweeps.join(" ")).not.toMatch(/system prune|network prune|container prune/);
    });

    it("runs the ordinary sweep on a server only Polaris uses", async () => {
        host.sharedHost = false;
        await space.reclaimServerSpace("host-1");
        expect(ran.filter((command) => command.includes("prune"))).toEqual([
            space.PRUNE_EVERY_ENGINE
        ]);
    });
});
