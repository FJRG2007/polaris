/**
 * A Redis Cluster as one managed database: one project of equal nodes, each with
 * its own command and data volume, on the database's networks, publishing
 * nothing - and named after the database so its first node is the container
 * everything else asks for.
 */

import { describe, expect, it } from "vitest";
import type { DbDeployPlan } from "../src/runtime/driver.js";
import { clusterNodeNames, dbComposeSpec, renderComposeYaml } from "../src/compose-spec.js";

const PROXY = "polaris-proxy";
const NAME = "shop-cache-ab12";
const VOLUME = "redis-data-abcd1234";

function plan(masters: number, networks?: string[]): DbDeployPlan {
    const names = clusterNodeNames(NAME, masters * 2);
    const volumes = clusterNodeNames(VOLUME, masters * 2);
    return {
        ref: { name: NAME, project: "polaris-db-abcd1234" },
        image: "redis:8-alpine",
        env: {},
        volumeName: VOLUME,
        dataPath: "/data",
        exposePort: 6380,
        limits: { memoryMb: 512 },
        ...(networks ? { networks } : {}),
        nodes: names.map((name, index) => ({
            name,
            command: ["redis-server", "--cluster-announce-hostname", name],
            volumeName: volumes[index]!
        }))
    };
}

describe("clusterNodeNames", () => {
    it("keeps the first name and numbers the rest", () => {
        expect(clusterNodeNames(NAME, 6)).toEqual([
            NAME,
            `${NAME}-n2`,
            `${NAME}-n3`,
            `${NAME}-n4`,
            `${NAME}-n5`,
            `${NAME}-n6`
        ]);
    });

    it("cuts a long name so every node still fits a DNS label", () => {
        const long = "a".repeat(63);
        const names = clusterNodeNames(long, 14);
        expect(names).toHaveLength(14);
        expect(new Set(names).size).toBe(14);
        for (const name of names) expect(name.length).toBeLessThanOrEqual(63);
        expect(names[13]).toBe(`${"a".repeat(59)}-n14`);
    });
});

describe("a clustered database's compose spec", () => {
    for (const masters of [3, 5, 7]) {
        it(`runs ${masters * 2} nodes for ${masters} masters, each on its own volume`, () => {
            const spec = dbComposeSpec(plan(masters), PROXY);
            expect(spec.project).toBe("polaris-db-abcd1234");
            expect(spec.services).toHaveLength(masters * 2);
            expect(spec.services.map((service) => service.name)).toEqual(clusterNodeNames(NAME, masters * 2));
            expect(spec.volumes).toEqual(clusterNodeNames(VOLUME, masters * 2));
            spec.services.forEach((service, index) => {
                expect(service.image).toBe("redis:8-alpine");
                expect(service.pullPolicy).toBe("always");
                expect(service.volumes).toEqual([
                    { source: clusterNodeNames(VOLUME, masters * 2)[index], target: "/data", kind: "volume" }
                ]);
                expect(service.command).toEqual(["redis-server", "--cluster-announce-hostname", service.name]);
                expect(service.memoryMb).toBe(512);
                expect(service.restart).toBe("unless-stopped");
            });
        });
    }

    it("publishes no node, even when the plan names a port", () => {
        const spec = dbComposeSpec(plan(3), PROXY);
        for (const service of spec.services) expect(service.ports).toEqual([]);
        expect(renderComposeYaml(spec, "/var/lib/polaris/volumes", "/mnt")).not.toContain("ports:");
    });

    it("puts every node on the database's own networks, so they reach each other by name", () => {
        const spec = dbComposeSpec(plan(3, ["polaris-env-1234"]), PROXY);
        expect(spec.networks).toEqual(["polaris-env-1234"]);
        for (const service of spec.services) expect(service.networks).toEqual(["polaris-env-1234"]);
    });

    it("renders one service per node, each with its container name and volume", () => {
        const yaml = renderComposeYaml(dbComposeSpec(plan(3), PROXY), "/var/lib/polaris/volumes", "/mnt");
        for (const [index, name] of clusterNodeNames(NAME, 6).entries()) {
            expect(yaml).toContain(`  ${name}:\n`);
            expect(yaml).toContain(`container_name: "${name}"`);
            expect(yaml).toContain(`"${clusterNodeNames(VOLUME, 6)[index]}:/data"`);
        }
    });

    it("leaves a single instance exactly as it was", () => {
        const { nodes: _nodes, ...single } = plan(3);
        const spec = dbComposeSpec({ ...single, command: ["redis-server"] }, PROXY);
        expect(spec.services).toHaveLength(1);
        expect(spec.services[0]!.name).toBe(NAME);
        expect(spec.services[0]!.ports).toEqual([{ host: 6380, container: 6379 }]);
        expect(spec.volumes).toEqual([VOLUME]);
    });
});
