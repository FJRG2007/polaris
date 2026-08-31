/**
 * A pull that had no room makes some and tries again.
 *
 * This is the failure a real deployment hit twice in an evening: 97% of 98 GB
 * used, a 2.7 GB image to fetch, and 6.5 GB of build cache on the same machine
 * that nothing was using. The deploy stopped, and everything needed to finish it
 * was sitting right there.
 *
 * Freeing it is unambiguously right at this exact moment and only at this
 * moment: something has already failed, and every byte of build cache is worth
 * less than the deploy that cannot land. Which is why it is bounded - once, and
 * only when the machine actually gave something back.
 */

import { describe, expect, it, vi } from "vitest";
import { ComposeRuntime } from "../src/runtime/compose.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";

/** What containerd says when the disk is full: a rename it could not finish. */
const NO_ROOM = [
    'failed commit on ref "layer-sha256:3fc760c2b0d9": commit failed: rename',
    "/var/lib/containerd/io.containerd.content.v1.content/ingest/2ca5059f/data",
    "/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/3fc760c2b0d9:",
    "no such file or directory"
].join(" ");

function plan(): AppDeployPlan {
    return {
        ref: { name: "vision", project: "polaris-vision" },
        build: { method: "image", name: "vision", imageRef: "ghcr.io/fjrg2007/polaris-vision:latest" },
        env: {},
        volumes: [],
        ports: [],
        domains: []
    } as unknown as AppDeployPlan;
}

/** A context whose pull fails for room `failures` times, then succeeds. */
function context(options: { failures: number; freed: number | null }) {
    const logged: string[] = [];
    let attempts = 0;
    const reclaimed = vi.fn(async () => {
        if (options.freed === null) throw new Error("the daemon would not say");
        return options.freed;
    });
    const ports = {
        pull: vi.fn(async () => {
            attempts += 1;
            if (attempts <= options.failures) throw new Error(NO_ROOM);
        }),
        composeUp: vi.fn(async () => undefined),
        ensureMount: vi.fn(async () => false),
        inspect: vi.fn(async () => ({})),
        ...(options.freed === undefined ? {} : { reclaimSpace: reclaimed })
    };
    const ctx = {
        ports,
        target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
        log: (chunk: Buffer) => logged.push(chunk.toString())
    } as unknown as RuntimeContext;
    return { ctx, ports, reclaimed, logged, attempts: () => attempts };
}

describe("a pull with no room left", () => {
    it("frees what nothing is using and fetches it again", async () => {
        const { ctx, ports, reclaimed, attempts } = context({ failures: 1, freed: 6_500_000_000 });
        await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(reclaimed).toHaveBeenCalledTimes(1);
        expect(ports.pull).toHaveBeenCalledTimes(2);
        expect(attempts()).toBe(2);
    });

    it("says what it did, in the log the operator is watching", async () => {
        const { ctx, logged } = context({ failures: 1, freed: 6_500_000_000 });
        await new ComposeRuntime().deployApplication(plan(), ctx);
        const said = logged.join("");
        expect(said).toContain("had no room");
        // The one reassurance that matters: their data was not what got freed.
        expect(said).toContain("no volume was touched");
    });

    it("gives up rather than looping when there was nothing to free", async () => {
        // A retry that freed nothing fails identically, and a loop pulling at a
        // full disk is a deploy that never ends and a log nobody can read.
        const { ctx, ports } = context({ failures: 2, freed: 0 });
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(ports.pull).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).toContain("disk space");
    });

    it("tries once and no more when the room was not enough either", async () => {
        const { ctx, ports } = context({ failures: 5, freed: 6_500_000_000 });
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(ports.pull).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(result)).toContain("disk space");
    });

    it("reports it the old way where nothing can be freed at all", async () => {
        // A remote engine, or an edition with no daemon to ask: no port, no
        // retry, and the same translated sentence as before.
        const { ctx, ports } = context({ failures: 1, freed: undefined as never });
        const result = await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(ports.pull).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).toContain("disk space");
    });
});

describe("making room before the pull rather than after it fails", () => {
    /** A context whose disk answers `fullness`, and whose pull always works. */
    function tight(fullness: number | null) {
        const order: string[] = [];
        const ports = {
            pull: vi.fn(async () => {
                order.push("pull");
            }),
            composeUp: vi.fn(async () => undefined),
            ensureMount: vi.fn(async () => false),
            inspect: vi.fn(async () => ({})),
            diskFullness: vi.fn(async () => {
                order.push("ask");
                return fullness;
            }),
            reclaimSpace: vi.fn(async () => {
                order.push("free");
                return 2_000_000_000;
            })
        };
        const ctx = {
            ports,
            target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
            log: () => undefined
        } as unknown as RuntimeContext;
        return { ctx, order };
    }

    it("frees first when the machine is already tight", async () => {
        // The loop this breaks: a pull that runs out of room part-way leaves what
        // it had already fetched behind, and nothing in a prune takes that back -
        // so failing first and cleaning afterwards is a machine that gets worse
        // every time somebody tries.
        const { ctx, order } = tight(0.93);
        await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(order).toEqual(["ask", "free", "pull"]);
    });

    it("does not touch a machine with room", async () => {
        const { ctx, order } = tight(0.4);
        await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(order).toEqual(["ask", "pull"]);
    });

    it("pulls anyway when the machine will not say how full it is", async () => {
        // Unknown is not full. A deploy refused because a `df` did not answer is
        // a deploy refused for nothing.
        const { ctx, order } = tight(null);
        await new ComposeRuntime().deployApplication(plan(), ctx);
        expect(order).toEqual(["ask", "pull"]);
    });
});
