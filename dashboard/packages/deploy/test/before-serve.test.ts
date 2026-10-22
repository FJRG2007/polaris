/**
 * Both runtimes ask `beforeServe` at the same point: once the release's image
 * is ready and pinned, before anything of it starts. A refusal fails the
 * release with the sentence it was given and starts nothing; null goes on.
 */

import { describe, expect, it, vi } from "vitest";
import { SwarmRuntime } from "../src/runtime/swarm.js";
import { ComposeRuntime } from "../src/runtime/compose.js";
import { releaseImage } from "../src/release-image.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";

const DEPLOYMENT = "0190f7a2-5b1c-7d3e-8f00-1234567890ab";
const PINNED = releaseImage("shop-web-1a2b", DEPLOYMENT);

function plan(): AppDeployPlan {
    return {
        ref: { name: "shop-web-1a2b", project: "polaris-1a2b" },
        build: {
            method: "image",
            name: "web",
            contextPath: ".",
            imageRef: "nginx:alpine",
            release: { image: PINNED, deploymentId: DEPLOYMENT }
        },
        env: {},
        replicas: 1,
        volumes: [],
        domains: []
    } as unknown as AppDeployPlan;
}

function context(beforeServe?: (refs: readonly string[]) => Promise<string | null>) {
    const logged: string[] = [];
    const ports = {
        pull: vi.fn(async () => undefined),
        build: vi.fn(async (request: { tag: string }) => request.tag),
        composeUp: vi.fn(async () => undefined),
        stackUp: vi.fn(async () => undefined),
        ensureMount: vi.fn(async () => false),
        inspect: vi.fn(async () => ({})),
        hasImage: vi.fn(async () => true)
    };
    const ctx = {
        ports,
        target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
        log: (chunk: Buffer) => logged.push(chunk.toString()),
        ...(beforeServe ? { beforeServe } : {})
    } as unknown as RuntimeContext;
    return { ctx, ports, logged };
}

const REFUSAL = "its image has 1 critical vulnerability with a known fix";

describe.each([
    ["compose", () => new ComposeRuntime(), "composeUp"],
    ["swarm", () => new SwarmRuntime(), "stackUp"]
] as const)("the %s runtime", (_name, runtime, up) => {
    it("asks with the pinned release and the reference it was pulled by", async () => {
        const ask = vi.fn(async () => null);
        const { ctx, ports } = context(ask);
        const result = await runtime().deployApplication(plan(), ctx);
        expect(result.ok).toBe(true);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(ask).toHaveBeenCalledWith([PINNED, "nginx:alpine"]);
        expect(ports[up]).toHaveBeenCalledTimes(1);
    });

    it("starts nothing when the release is refused, and says why", async () => {
        const { ctx, ports, logged } = context(async () => REFUSAL);
        const result = await runtime().deployApplication(plan(), ctx);
        expect(result).toEqual({ ok: false, error: REFUSAL });
        expect(ports[up]).not.toHaveBeenCalled();
        expect(logged.join("")).toContain(REFUSAL);
    });

    it("goes on as before when nothing asks", async () => {
        const { ctx, ports } = context();
        const result = await runtime().deployApplication(plan(), ctx);
        expect(result.ok).toBe(true);
        expect(ports[up]).toHaveBeenCalledTimes(1);
    });
});
