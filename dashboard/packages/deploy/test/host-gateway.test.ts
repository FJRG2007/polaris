/**
 * A container Polaris starts can reach the machine it is running on.
 *
 * This is the failure it exists to stop, and it took a long afternoon to see:
 * the vision worker's ffmpeg exited immediately, over and over, because the
 * camera relay it was told to read is published on the host and
 * `host.docker.internal` resolved to nothing inside the container. ffmpeg's
 * stderr was discarded, so nothing said so - what the operator saw was a camera
 * that had noticed nothing since the day it was added.
 *
 * Polaris' own services get the entry from the stack's compose file. Anything
 * Polaris deploys has to be given it here.
 */

import { describe, expect, it } from "vitest";
import { appComposeSpec, dbComposeSpec, HOST_GATEWAY, renderComposeYaml } from "../src/compose-spec.js";
import type { AppDeployPlan, DbDeployPlan } from "../src/runtime/driver.js";

const NETWORK = "polaris-proxy";

function appPlan(): AppDeployPlan {
    return {
        ref: { name: "vision-worker", project: "polaris-abcd1234" },
        build: { method: "image", name: "vision-worker", contextPath: "/ctx", imageRef: "ghcr.io/x/vision:latest" },
        env: {},
        replicas: 1,
        domains: [],
        volumes: []
    } as unknown as AppDeployPlan;
}

function dbPlan(): DbDeployPlan {
    return {
        ref: { name: "db", project: "polaris-abcd1234" },
        image: "postgres:16",
        env: { POSTGRES_PASSWORD: "secret" },
        volumeName: "db-data",
        dataPath: "/var/lib/postgresql/data"
    } as unknown as DbDeployPlan;
}

describe("reaching the host from inside", () => {
    it("gives an app the name of the machine it runs on", () => {
        const spec = appComposeSpec(appPlan(), "ghcr.io/x/vision:latest", NETWORK);
        expect(spec.services[0]!.extraHosts).toContain(HOST_GATEWAY);
    });

    it("gives a database the same", () => {
        expect(dbComposeSpec(dbPlan(), NETWORK).services[0]!.extraHosts).toContain(HOST_GATEWAY);
    });

    it("writes it into the YAML the remote path sends", () => {
        const yaml = renderComposeYaml(appComposeSpec(appPlan(), "ghcr.io/x/vision:latest", NETWORK), "/vol", "/mnt");
        expect(yaml).toContain("extra_hosts:");
        expect(yaml).toContain("host.docker.internal:host-gateway");
    });

    it("names the gateway the way Docker answers it", () => {
        // `host-gateway` is the magic address Docker resolves to the host on the
        // container's own network. Any other spelling is a name that resolves to
        // nothing, which is the failure this whole file is about.
        expect(HOST_GATEWAY).toBe("host.docker.internal:host-gateway");
    });
});
