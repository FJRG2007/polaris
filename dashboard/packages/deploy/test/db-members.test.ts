/**
 * A database laid out over several containers is one compose project with a
 * service per member: each with its own volume, on the same networks, the image
 * of its own during a rolling upgrade, and a port only where one is published.
 * The daemon's spec and the remote YAML are both read from it.
 */

import { describe, expect, it, vi } from "vitest";
import { ComposeRuntime } from "../src/runtime/compose.js";
import type { DbDeployPlan, RuntimeContext } from "../src/runtime/driver.js";
import { dbComposeSpec, dbPlanImages, forCompose, renderComposeYaml } from "../src/compose-spec.js";

const NETWORK = "polaris-proxy";

function plan(overrides: Partial<DbDeployPlan> = {}): DbDeployPlan {
    return {
        ref: { name: "shop-orders-1a2b", project: "polaris-db-1a2b3c4d" },
        image: "mongo:7",
        env: { MONGO_INITDB_ROOT_USERNAME: "polaris" },
        volumeName: "mongo-data-1a2b3c4d",
        dataPath: "/data/db",
        limits: { cpus: 1, memoryMb: 512 },
        members: [
            { name: "shop-orders-1a2b", env: { A: "1" }, command: ["sh", "-c", "exec mongod"], volumeName: "mongo-data-1a2b3c4d" },
            { name: "shop-orders-1a2b-m2", env: { B: "2" }, volumeName: "mongo-data-1a2b3c4d-m2" },
            { name: "shop-orders-1a2b-m3", env: { B: "2" }, volumeName: "mongo-data-1a2b3c4d-m3", image: "mongo:8" }
        ],
        ...overrides
    };
}

describe("dbComposeSpec with members", () => {
    it("runs a service per member in the database's one project", () => {
        const spec = dbComposeSpec(plan(), NETWORK);
        expect(spec.project).toBe("polaris-db-1a2b3c4d");
        expect(spec.services.map((service) => service.name)).toEqual([
            "shop-orders-1a2b",
            "shop-orders-1a2b-m2",
            "shop-orders-1a2b-m3"
        ]);
        expect(spec.services.every((service) => service.networks.join() === NETWORK)).toBe(true);
    });

    it("gives every member with data a volume of its own at the data path", () => {
        const spec = dbComposeSpec(plan(), NETWORK);
        expect(spec.volumes).toEqual(["mongo-data-1a2b3c4d", "mongo-data-1a2b3c4d-m2", "mongo-data-1a2b3c4d-m3"]);
        expect(spec.services[1]!.volumes).toEqual([{ source: "mongo-data-1a2b3c4d-m2", target: "/data/db", kind: "volume" }]);
    });

    it("keeps each member's own environment, command and image, and the plan's limits", () => {
        const [first, second, third] = dbComposeSpec(plan(), NETWORK).services;
        expect(first!.env).toEqual({ A: "1" });
        expect(first!.command).toEqual(["sh", "-c", "exec mongod"]);
        expect(second!.command).toBeUndefined();
        expect(second!.image).toBe("mongo:7");
        expect(third!.image).toBe("mongo:8");
        expect(third!.cpus).toBe(1);
        expect(third!.memoryMb).toBe(512);
    });

    it("publishes a port only on the member that asks, and gives a router no volume", () => {
        const spec = dbComposeSpec(
            plan({
                members: [
                    { name: "shop-orders-1a2b", env: {}, exposePort: 27018 },
                    { name: "shop-orders-1a2b-cfg1", env: {}, volumeName: "v-cfg1" }
                ]
            }),
            NETWORK
        );
        expect(spec.services[0]!.ports).toEqual([{ host: 27018, container: 27017 }]);
        expect(spec.services[0]!.volumes).toEqual([]);
        expect(spec.services[1]!.ports).toEqual([]);
        expect(spec.volumes).toEqual(["v-cfg1"]);
    });

    it("lets read replicas answer to the name they share", () => {
        const spec = dbComposeSpec(
            plan({
                image: "mysql:8",
                members: [
                    { name: "shop-orders-1a2b", env: {}, volumeName: "v" },
                    { name: "shop-orders-1a2b-replica1", env: {}, volumeName: "v-r1", aliases: ["shop-orders-1a2b-read"] }
                ]
            }),
            NETWORK
        );
        expect(spec.services[0]!.aliases).toBeUndefined();
        expect(spec.services[1]!.aliases).toEqual(["shop-orders-1a2b-read"]);
        const yaml = renderComposeYaml(spec, "/var/lib/polaris/volumes", "/mnt/polaris");
        expect(yaml).toContain('container_name: "shop-orders-1a2b-replica1"');
        expect(yaml).toContain('          - "shop-orders-1a2b-read"');
    });

    it("refuses members that would collide, or a plan whose own name is not one of them", () => {
        expect(() =>
            dbComposeSpec(
                plan({ members: [{ name: "shop-orders-1a2b", env: {} }, { name: "shop-orders-1a2b", env: {} }] }),
                NETWORK
            )
        ).toThrow("cannot share a name");
        expect(() => dbComposeSpec(plan({ members: [{ name: "other", env: {} }] }), NETWORK)).toThrow("must be one of its members");
    });

    it("pulls every image the members run, once each", () => {
        expect(dbPlanImages(plan())).toEqual(["mongo:7", "mongo:8"]);
        expect(dbPlanImages(plan({ members: undefined }))).toEqual(["mongo:7"]);
    });

    it("fetches every image again, except in a rolling upgrade's step, which runs what the host has", () => {
        expect(dbComposeSpec(plan(), NETWORK).services.map((service) => service.pullPolicy)).toEqual([
            "always",
            "always",
            "always"
        ]);
        const rolling = dbComposeSpec(plan({ keepImages: true }), NETWORK);
        expect(rolling.services.map((service) => service.pullPolicy)).toEqual(["missing", "missing", "missing"]);
        expect(renderComposeYaml(rolling, "/var/lib/polaris/volumes", "/mnt/polaris")).toContain('pull_policy: "missing"');
    });

    it("is still one container without members", () => {
        const spec = dbComposeSpec(plan({ members: undefined }), NETWORK);
        expect(spec.services).toHaveLength(1);
        expect(spec.services[0]!.volumes[0]).toEqual({ source: "mongo-data-1a2b3c4d", target: "/data/db", kind: "volume" });
    });
});

describe("deploying the members", () => {
    function context(present: readonly string[] | null) {
        const ports = {
            pull: vi.fn(async () => undefined),
            composeUp: vi.fn(async () => undefined),
            ...(present ? { hasImage: vi.fn(async (image: string) => present.includes(image)) } : {})
        };
        const ctx = {
            ports,
            target: { id: "local", kind: "local", engine: "compose", proxyNetwork: NETWORK },
            log: () => undefined
        } as unknown as RuntimeContext;
        return { ctx, ports };
    }

    it("pulls every image first on an ordinary deploy", async () => {
        const { ctx, ports } = context(["mongo:7", "mongo:8"]);
        await new ComposeRuntime().deployDatabase(plan(), ctx);
        expect(ports.pull.mock.calls.map(([image]) => image)).toEqual(["mongo:7", "mongo:8"]);
    });

    it("pulls none the host has during a rolling upgrade, so a moved tag restarts no other member", async () => {
        const { ctx, ports } = context(["mongo:7"]);
        const result = await new ComposeRuntime().deployDatabase(plan({ keepImages: true }), ctx);
        expect(result.ok).toBe(true);
        expect(ports.pull.mock.calls.map(([image]) => image)).toEqual(["mongo:8"]);
    });

    it("leaves the fetch to compose when the host cannot say what it has", async () => {
        const { ctx, ports } = context(null);
        await new ComposeRuntime().deployDatabase(plan({ keepImages: true }), ctx);
        expect(ports.pull).not.toHaveBeenCalled();
        expect(ports.composeUp).toHaveBeenCalledTimes(1);
    });
});

describe("forCompose", () => {
    it("refuses a command with a line break, naming the service", () => {
        const spec = dbComposeSpec(
            plan({ members: [{ name: "shop-orders-1a2b", env: {}, command: ["sh", "-c", "set -e\nexec mongod"] }] }),
            NETWORK
        );
        expect(() => forCompose(spec)).toThrow("shop-orders-1a2b's command holds a line break");
    });

    it("passes a one-line command through, escaped for compose", () => {
        const spec = dbComposeSpec(
            plan({ members: [{ name: "shop-orders-1a2b", env: {}, command: ["sh", "-c", 'printf "%s" "$KEY"'] }] }),
            NETWORK
        );
        expect(forCompose(spec).services[0]!.command).toEqual(["sh", "-c", 'printf "%s" "$$KEY"']);
    });
});
