/**
 * Every release keeps the image it ran, and a rollback runs exactly that.
 *
 * Before this, a build was tagged `<slug>:latest` and the next build took the tag
 * over, and a pulled image ran by its registry name, which moves whenever the
 * publisher pushes - so an old version could not be run again, only rebuilt from
 * today's source. These pin the four things the fix rests on: the name is per
 * deployment and cannot be spoofed by a look-alike, the pin build's context is a
 * valid tar, a pin that fails never fails the deploy, and a rollback neither
 * pulls nor builds.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SwarmRuntime } from "../src/runtime/swarm.js";
import { ComposeRuntime } from "../src/runtime/compose.js";
import { RELEASE_IMAGE_GONE } from "../src/runtime/release.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";
import {
    isReleaseImage,
    pinDockerfile,
    releaseImage,
    singleFileTar
} from "../src/release-image.js";

const DEPLOYMENT = "0190f7a2-5b1c-7d3e-8f00-1234567890ab";

describe("naming a kept release", () => {
    it("gives every deployment its own name under the release repository", () => {
        const one = releaseImage("shop-web-1a2b", DEPLOYMENT);
        const two = releaseImage("shop-web-1a2b", "0190f7a2-5b1c-7d3e-8f00-000000000000");
        expect(one).toMatch(/^polaris-release\/shop-web-1a2b:[a-f0-9]{12}$/);
        expect(one).not.toBe(two);
        expect(isReleaseImage(one)).toBe(true);
    });

    it("recognises only its own names, because the answer decides a removal", () => {
        for (const other of [
            "nginx:latest",
            "polaris-release/web:latest",
            "polaris-release/web:0123456789ab extra",
            "evil/polaris-release/web:0123456789ab",
            "polaris-release/../web:0123456789ab",
            null,
            undefined
        ]) {
            expect(isReleaseImage(other), String(other)).toBe(false);
        }
    });

    it("refuses to write a Dockerfile around anything that is not an image reference", () => {
        expect(pinDockerfile("nginx:1.27-alpine", DEPLOYMENT)).toBe(
            `FROM nginx:1.27-alpine\nLABEL polaris.release="${DEPLOYMENT}"\n`
        );
        expect(() => pinDockerfile("nginx\nRUN rm -rf /", DEPLOYMENT)).toThrow();
        expect(() => pinDockerfile("nginx", 'x"\nRUN id')).toThrow();
    });
});

describe("the pin build's context", () => {
    it("is a tar archive holding the one Dockerfile", () => {
        const archive = singleFileTar("Dockerfile", pinDockerfile("nginx:alpine", DEPLOYMENT));
        expect(archive.length % 512).toBe(0);
        // The header checksum is the sum of its bytes with the field read as spaces.
        const header = Buffer.from(archive.subarray(0, 512));
        const stored = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
        header.fill(0x20, 148, 156);
        expect(stored).toBe(header.reduce((sum, byte) => sum + byte, 0));
        // And a real tar reads it back, where one is installed to ask.
        const listed = spawnSync("tar", ["-tf", "-"], { input: archive });
        if (listed.status === 0) expect(listed.stdout.toString().trim()).toBe("Dockerfile");
    });
});

function plan(over: Partial<AppDeployPlan["build"]> = {}): AppDeployPlan {
    return {
        ref: { name: "shop-web-1a2b", project: "polaris-1a2b" },
        build: {
            method: "image",
            name: "web",
            contextPath: ".",
            imageRef: "nginx:alpine",
            release: { image: releaseImage("shop-web-1a2b", DEPLOYMENT), deploymentId: DEPLOYMENT },
            ...over
        },
        env: {},
        replicas: 1,
        volumes: [],
        domains: []
    } as AppDeployPlan;
}

function context(options: { buildFails?: boolean; present?: boolean } = {}) {
    const logged: string[] = [];
    const ports = {
        pull: vi.fn(async () => undefined),
        build: vi.fn(async (request: { tag: string }) => {
            if (options.buildFails) throw new Error("the builder is not there");
            return request.tag;
        }),
        composeUp: vi.fn(async (_spec: { services: { image: string }[] }) => undefined),
        stackUp: vi.fn(async (_spec: { services: { image: string }[] }) => undefined),
        ensureMount: vi.fn(async () => false),
        inspect: vi.fn(async () => ({})),
        hasImage: vi.fn(async () => options.present ?? true)
    };
    const ctx = {
        ports,
        target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
        log: (chunk: Buffer) => logged.push(chunk.toString())
    } as unknown as RuntimeContext;
    return { ctx, ports, logged };
}

describe("a release is kept as it goes live", () => {
    it("runs the pinned image, not the registry name", async () => {
        const { ctx, ports } = context();
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(result.ok).toBe(true);
        expect(result.imageTag).toBe(releaseImage("shop-web-1a2b", DEPLOYMENT));
        expect(ports.build).toHaveBeenCalledTimes(1);
        const spec = ports.composeUp.mock.calls[0]?.[0];
        expect(JSON.stringify(spec)).toContain("polaris-release/shop-web-1a2b:");
    });

    it("still goes live when the release cannot be kept, and says so", async () => {
        const { ctx, logged } = context({ buildFails: true });
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(result.ok).toBe(true);
        expect(result.imageTag).toBe("nginx:alpine");
        expect(logged.join("")).toContain("could not be kept for an instant rollback");
    });

    it("keeps a swarm release the same way", async () => {
        const { ctx, ports } = context();
        const result = await new SwarmRuntime().deployApplication(plan(), ctx);
        expect(result.imageTag).toBe(releaseImage("shop-web-1a2b", DEPLOYMENT));
        expect(ports.build).toHaveBeenCalledTimes(1);
    });
});

describe("rolling back", () => {
    const kept = releaseImage("shop-web-1a2b", "0190f7a2-5b1c-7d3e-8f00-00000000beef");

    it("runs the kept image and neither pulls nor builds", async () => {
        const { ctx, ports } = context();
        const result = await new ComposeRuntime().deployApplication(
            plan({ rollbackImage: kept, release: undefined }),
            ctx
        );
        expect(result).toMatchObject({ ok: true, imageTag: kept });
        expect(ports.pull).not.toHaveBeenCalled();
        expect(ports.build).not.toHaveBeenCalled();
    });

    it("refuses in words when the kept image has gone from the machine", async () => {
        const { ctx, ports } = context({ present: false });
        const result = await new ComposeRuntime().deployApplication(
            plan({ rollbackImage: kept, release: undefined }),
            ctx
        );
        expect(result).toMatchObject({ ok: false, error: RELEASE_IMAGE_GONE });
        expect(ports.composeUp).not.toHaveBeenCalled();
    });
});
