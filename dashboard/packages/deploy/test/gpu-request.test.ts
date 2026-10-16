/**
 * A service that asks for the GPU is handed NVIDIA cards as a device
 * reservation, which compose turns into a device request for the `nvidia`
 * driver. The host daemon renders the same lines for the machine Polaris runs on.
 */

import { describe, expect, it } from "vitest";
import type { AppDeployPlan } from "../src/runtime/driver.js";
import {
    appComposeSpec,
    deployBlockLines,
    forCompose,
    renderComposeYaml
} from "../src/compose-spec.js";

const NETWORK = "polaris-proxy";

function appPlan(limits?: AppDeployPlan["limits"]): AppDeployPlan {
    return {
        ref: { name: "trainer", project: "polaris-abcd1234" },
        build: {
            method: "image",
            name: "trainer",
            contextPath: "/ctx",
            imageRef: "nvidia/cuda:12.4.1-base-ubuntu22.04"
        },
        env: {},
        replicas: 1,
        domains: [],
        volumes: [],
        ...(limits ? { limits } : {})
    } as unknown as AppDeployPlan;
}

describe("a GPU request", () => {
    it("renders every card as an nvidia device reservation", () => {
        const spec = appComposeSpec(
            appPlan({ gpus: "all" }),
            "nvidia/cuda:12.4.1-base-ubuntu22.04",
            NETWORK
        );
        expect(spec.services[0]!.gpus).toBe("all");
        const yaml = renderComposeYaml(forCompose(spec), "/vol", "/mnt");
        expect(yaml).toContain(
            [
                "    deploy:",
                "      resources:",
                "        reservations:",
                "          devices:",
                "            - driver: nvidia",
                "              count: all",
                '              capabilities: ["gpu"]'
            ].join("\n")
        );
    });

    it("shares one resources mapping with the limits", () => {
        const lines = deployBlockLines({ memoryMb: 512, gpus: 2 });
        expect(lines).toEqual([
            "    deploy:",
            "      resources:",
            "        limits:",
            "          memory: 512M",
            "        reservations:",
            "          devices:",
            "            - driver: nvidia",
            "              count: 2",
            '              capabilities: ["gpu"]'
        ]);
    });

    it("asks for nothing when the service did not", () => {
        const spec = appComposeSpec(appPlan({ memoryMb: 256 }), "nginx:1.27", NETWORK);
        expect(spec.services[0]!.gpus).toBeUndefined();
        expect(renderComposeYaml(forCompose(spec), "/vol", "/mnt")).not.toContain("nvidia");
        expect(deployBlockLines({})).toEqual([]);
    });
});
