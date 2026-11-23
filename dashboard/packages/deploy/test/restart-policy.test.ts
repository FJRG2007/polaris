/**
 * A service's restart policy reaches every engine in the words it reads: plain
 * compose from `restart:`, swarm from `deploy.restart_policy`, and this machine's
 * daemon from the plain policy names it accepts.
 */

import { describe, expect, it } from "vitest";
import type { AppDeployPlan, RestartPolicy } from "../src/runtime/driver.js";
import {
    appComposeSpec,
    composeRestart,
    forCompose,
    forDaemon,
    forSwarm,
    renderComposeYaml
} from "../src/compose-spec.js";

const NETWORK = "polaris-proxy";

function plan(restart?: RestartPolicy): AppDeployPlan {
    return {
        ref: { name: "worker", project: "polaris-abcd1234" },
        build: { method: "image", name: "worker", contextPath: "/ctx", imageRef: "nginx:1.27" },
        env: {},
        replicas: 1,
        domains: [],
        volumes: [],
        ...(restart ? { restart } : {})
    } as unknown as AppDeployPlan;
}

describe("composeRestart", () => {
    it("keeps unless-stopped when no policy was chosen", () => {
        expect(composeRestart(undefined)).toBe("unless-stopped");
    });
    it("maps each policy", () => {
        expect(composeRestart({ policy: "never", maxRetries: 10 })).toBe("no");
        expect(composeRestart({ policy: "on-failure", maxRetries: 3 })).toBe("on-failure:3");
        expect(composeRestart({ policy: "always", maxRetries: 10 })).toBe("unless-stopped");
    });
});

describe("a service's restart policy", () => {
    it("is written as compose's restart value", () => {
        const yaml = renderComposeYaml(
            forCompose(appComposeSpec(plan({ policy: "on-failure", maxRetries: 5 }), "nginx:1.27", NETWORK)),
            "/vol",
            "/mnt"
        );
        expect(yaml).toContain('restart: "on-failure:5"');
        expect(yaml).not.toContain("restart_policy");
    });

    it("goes to the daemon without a count", () => {
        const spec = forDaemon(appComposeSpec(plan({ policy: "on-failure", maxRetries: 5 }), "nginx:1.27", NETWORK));
        expect(spec.services[0]!.restart).toBe("on-failure");
        const never = forDaemon(appComposeSpec(plan({ policy: "never", maxRetries: 5 }), "nginx:1.27", NETWORK));
        expect(never.services[0]!.restart).toBe("no");
    });

    it("becomes swarm's restart_policy with its attempts", () => {
        const yaml = renderComposeYaml(
            forSwarm(appComposeSpec(plan({ policy: "on-failure", maxRetries: 4 }), "nginx:1.27", NETWORK)),
            "/vol",
            "/mnt"
        );
        expect(yaml).toContain("restart_policy:");
        expect(yaml).toContain("condition: on-failure");
        expect(yaml).toContain("max_attempts: 4");

        const never = renderComposeYaml(
            forSwarm(appComposeSpec(plan({ policy: "never", maxRetries: 4 }), "nginx:1.27", NETWORK)),
            "/vol",
            "/mnt"
        );
        expect(never).toContain("condition: none");
    });

    it("leaves swarm's own default alone without a policy", () => {
        const yaml = renderComposeYaml(forSwarm(appComposeSpec(plan(), "nginx:1.27", NETWORK)), "/vol", "/mnt");
        expect(yaml).not.toContain("restart_policy");
    });
});
