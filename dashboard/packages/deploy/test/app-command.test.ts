/**
 * A service can replace its image's command.
 *
 * MinIO is the case that needs it: its image's own command prints the help and
 * exits, and its entrypoint prepends `minio` to whatever arguments it is given -
 * so `server /data` has to arrive as those words, not as a shell line, or the
 * container starts `minio sh -c ...` and exits on every boot.
 */

import { describe, expect, it } from "vitest";
import type { AppDeployPlan } from "../src/runtime/driver.js";
import { appComposeSpec, forCompose, renderComposeYaml } from "../src/compose-spec.js";

const NETWORK = "polaris-proxy";

function appPlan(command?: readonly string[]): AppDeployPlan {
    return {
        ref: { name: "storage", project: "polaris-abcd1234" },
        build: {
            method: "image",
            name: "storage",
            contextPath: "/ctx",
            imageRef: "minio/minio:latest"
        },
        env: {},
        replicas: 1,
        domains: [],
        volumes: [],
        ...(command ? { command } : {})
    } as unknown as AppDeployPlan;
}

describe("an application's command", () => {
    it("is handed to the container as its arguments, one word each", () => {
        const spec = appComposeSpec(
            appPlan(["server", "/data", "--console-address", ":9001"]),
            "minio/minio:latest",
            NETWORK
        );
        expect(spec.services[0]!.command).toEqual([
            "server",
            "/data",
            "--console-address",
            ":9001"
        ]);

        const yaml = renderComposeYaml(forCompose(spec), "/vol", "/mnt");
        expect(yaml).toContain("command: [");
        expect(yaml).toContain("--console-address");
    });

    it("leaves the image's own command alone when none is set", () => {
        expect(
            appComposeSpec(appPlan(), "nginx:1.27", NETWORK).services[0]!.command
        ).toBeUndefined();
        expect(
            appComposeSpec(appPlan([]), "nginx:1.27", NETWORK).services[0]!.command
        ).toBeUndefined();
    });
});
