import { describe, expect, it } from "vitest";
import type { AppDeployPlan, DbDeployPlan } from "../src/runtime/driver.js";
import { appComposeSpec, dbComposeSpec, forSwarm, renderComposeYaml } from "../src/compose-spec.js";

// Compose's own default is "missing": an image tag already on the host is reused
// without asking the registry, so a deploy of a moved mutable tag (`:latest`, a
// branch tag) silently reruns the previous build. These pin the policy each kind
// of source needs, and the YAML the remote path writes.
const PROXY_NETWORK = "polaris-proxy";

function appPlan(method: AppDeployPlan["build"]["method"]): AppDeployPlan {
    return {
        ref: { name: "api", project: "polaris-abcd1234" },
        build: { method, name: "api", contextPath: "/ctx", imageRef: "ghcr.io/acme/api:latest" },
        env: {},
        replicas: 1,
        domains: [],
        volumes: []
    };
}

function dbPlan(): DbDeployPlan {
    return {
        ref: { name: "db", project: "polaris-abcd1234" },
        image: "postgres:16",
        env: { POSTGRES_PASSWORD: "secret" },
        volumeName: "db-data",
        dataPath: "/var/lib/postgresql/data"
    };
}

describe("image pull policy", () => {
    it("always re-resolves an image that comes from a registry", () => {
        expect(appComposeSpec(appPlan("image"), "ghcr.io/acme/api:latest", PROXY_NETWORK).services[0].pullPolicy).toBe(
            "always"
        );
    });

    it("never tries to fetch an image this host built, which no registry has", () => {
        for (const method of ["dockerfile", "nixpacks"] as const) {
            expect(appComposeSpec(appPlan(method), "polaris/api:abc1234", PROXY_NETWORK).services[0].pullPolicy).toBe(
                "never"
            );
        }
    });

    it("always re-resolves a database engine image", () => {
        expect(dbComposeSpec(dbPlan(), PROXY_NETWORK).services[0].pullPolicy).toBe("always");
    });

    it("drops the policy for a swarm stack, which resolves the digest itself", () => {
        // `docker stack deploy` warns on every unsupported key, and a warning on a
        // deploy log reads like a failure to whoever is watching it.
        const spec = forSwarm(appComposeSpec(appPlan("image"), "ghcr.io/acme/api:latest", PROXY_NETWORK));
        expect(spec.services[0].pullPolicy).toBeUndefined();
        expect(renderComposeYaml(spec, "/var/polaris/volumes", "/var/polaris/mounts")).not.toContain("pull_policy");
        // Everything else survives - this drops one key, it is not a rebuild.
        expect(spec.services[0].image).toBe("ghcr.io/acme/api:latest");
        expect(spec.networks).toEqual([PROXY_NETWORK]);
    });

    it("writes the policy into the compose file the remote path deploys", () => {
        const yaml = renderComposeYaml(
            appComposeSpec(appPlan("image"), "ghcr.io/acme/api:latest", PROXY_NETWORK),
            "/var/polaris/volumes",
            "/var/polaris/mounts"
        );
        expect(yaml).toContain('pull_policy: "always"');
    });
});
