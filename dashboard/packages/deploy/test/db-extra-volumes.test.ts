/**
 * A database's mounts beside its data volume.
 *
 * A PostgreSQL instance kept for point-in-time recovery mounts its archive
 * folder, and an instance recovered from it mounts the same folder, so both
 * have to resolve to one host path under the volume root - and a host folder
 * must never be declared as a named volume, which compose would create empty.
 */

import { describe, expect, it } from "vitest";
import type { DbDeployPlan } from "../src/runtime/driver.js";
import { dbComposeSpec, renderComposeYaml } from "../src/compose-spec.js";

const NETWORK = "polaris-proxy";

function plan(extra?: DbDeployPlan["extraVolumes"]): DbDeployPlan {
    return {
        ref: { name: "db", project: "polaris-db-abcd1234" },
        image: "postgres:17-alpine",
        env: {},
        volumeName: "postgres-data-abcd1234",
        dataPath: "/var/lib/postgresql/data",
        ...(extra ? { extraVolumes: extra } : {})
    };
}

describe("a database's extra mounts", () => {
    it("mounts nothing more when none are asked for", () => {
        const spec = dbComposeSpec(plan(), NETWORK);
        expect(spec.services[0]!.volumes).toHaveLength(1);
        expect(spec.volumes).toEqual(["postgres-data-abcd1234"]);
    });

    it("binds an archive folder under the volume root without declaring it a volume", () => {
        const spec = dbComposeSpec(
            plan([{ source: "pitr/db-1", target: "/polaris-pitr", kind: "bind" }]),
            NETWORK
        );
        expect(spec.volumes).toEqual(["postgres-data-abcd1234"]);
        const yaml = renderComposeYaml(spec, "/var/lib/polaris/volumes", "/mnt");
        expect(yaml).toContain("/var/lib/polaris/volumes/pitr/db-1:/polaris-pitr");
        expect(yaml).toContain("postgres-data-abcd1234:/var/lib/postgresql/data");
    });

    it("declares an extra named volume so compose creates it", () => {
        const spec = dbComposeSpec(
            plan([{ source: "cache-data", target: "/cache", kind: "volume" }]),
            NETWORK
        );
        expect(spec.volumes).toEqual(["postgres-data-abcd1234", "cache-data"]);
    });
});
