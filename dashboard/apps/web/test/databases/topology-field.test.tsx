/**
 * The layout choice in the new-database form: offered for the engines that have
 * one, and saying plainly what a sharded cluster does not get yet.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
    DatabaseTopologyField,
    hasTopologyChoice,
    SINGLE_TOPOLOGY
} from "@/app/(app)/apps/deploy/database-topology-field";

function render(engine: string, value = SINGLE_TOPOLOGY): string {
    return renderToStaticMarkup(<DatabaseTopologyField engine={engine} value={value} onChange={() => undefined} />);
}

describe("the layout field", () => {
    it("is offered for MongoDB and MySQL only", () => {
        expect(["mongo", "mysql"].every(hasTopologyChoice)).toBe(true);
        expect(["postgres", "mariadb", "redis", "seaweedfs"].some(hasTopologyChoice)).toBe(false);
        expect(render("postgres")).toBe("");
    });

    it("offers MongoDB as a single instance, a replica set or a sharded cluster", () => {
        const html = render("mongo");
        expect(html).toContain("Single");
        expect(html).toContain("Replica set");
        expect(html).toContain("Sharded");
        expect(html).toContain("One container.");
    });

    it("counts a sharded cluster's containers and says what it does not get yet", () => {
        const html = render("mongo", { topology: "sharded", shards: 2 });
        expect(html).toContain("10 containers");
        expect(html).toContain("Each collection stays on one shard until your application shards it with a shard key");
        expect(html).toContain("Backups and version changes are not offered for it yet.");
    });

    it("offers MySQL read replicas", () => {
        const html = render("mysql", { topology: "replicas", readReplicas: 2 });
        expect(html).toContain("Read replicas");
        expect(html).toContain("GTID replication");
    });
});
