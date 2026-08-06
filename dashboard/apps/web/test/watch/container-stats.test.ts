/**
 * Reading many containers' stats at once, without overrunning the connection.
 *
 * The two failure modes pull in opposite directions. One at a time is what made
 * Watch slow: the daemon holds every one-shot stats request open for about a
 * second to get its second CPU sample, so the wait is per container. All at once
 * is worse than slow: over SSH each request is its own exec channel and sshd
 * closes the ones past MaxSessions, so a busy machine would silently lose
 * readings. Hence a bounded batch, which is what these pin down.
 */

import { describe, expect, it } from "vitest";
import { DockerDriver, type DockerRpc } from "@polaris/docker";

/** A stats body the driver can parse: 25% of one CPU, 100 MB of 1 GB. */
function statsBody(): string {
    return JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: 250 }, system_cpu_usage: 1000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        memory_stats: { usage: 100_000_000, limit: 1_000_000_000 }
    });
}

/** An engine that never answers before the caller has stopped asking, so the
 *  requests in flight at once can be counted. `fail` refuses those containers. */
function slowEngine(fail: Set<string> = new Set()) {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const rpc: DockerRpc = {
        request: async (_method, path) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise<void>((resolve) => release.push(resolve));
            inFlight -= 1;
            const id = /containers\/([^/]+)\/stats/.exec(path)?.[1] ?? "";
            const body = fail.has(id) ? "no such container" : statsBody();
            return { status: fail.has(id) ? 404 : 200, body, bytes: Buffer.from(body, "utf8") };
        },
        dispose: async () => undefined
    };
    return {
        driver: new DockerDriver(rpc),
        get peak() {
            return peak;
        },
        /** Let everything currently waiting answer, then hand control back so the
         *  next batch can start. */
        async drain(): Promise<void> {
            for (let round = 0; round < 20; round += 1) {
                while (release.length > 0) release.pop()?.();
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
    };
}

describe("reading stats for a machine full of containers", () => {
    it("keeps the requests in flight under the channel ceiling", async () => {
        const engine = slowEngine();
        const ids = Array.from({ length: 20 }, (_, index) => `c${index}`);

        const pending = engine.driver.statsMany(ids);
        await engine.drain();
        const stats = await pending;

        expect(stats.size).toBe(20);
        expect(engine.peak).toBeLessThanOrEqual(6);
        // And it is actually reading them together, not one by one.
        expect(engine.peak).toBeGreaterThan(1);
    });

    it("answers for every container it was asked about", async () => {
        const engine = slowEngine();
        const ids = ["alpha", "beta", "gamma"];

        const pending = engine.driver.statsMany(ids);
        await engine.drain();
        const stats = await pending;

        expect([...stats.keys()].sort()).toEqual(["alpha", "beta", "gamma"]);
        expect(stats.get("alpha")?.cpuPercent).toBe(25);
        expect(stats.get("alpha")?.memUsage).toBe(100_000_000);
    });

    it("lets one container that stopped mid-pass fail on its own", async () => {
        const engine = slowEngine(new Set(["beta"]));

        const pending = engine.driver.statsMany(["alpha", "beta", "gamma"]);
        await engine.drain();
        const stats = await pending;

        // Null rather than a missing key or a thrown batch: the container is
        // known, its reading is not.
        expect(stats.get("beta")).toBeNull();
        expect(stats.get("alpha")).not.toBeNull();
        expect(stats.get("gamma")).not.toBeNull();
    });

    it("asks nothing of a machine with no running containers", async () => {
        const engine = slowEngine();

        const stats = await engine.driver.statsMany([]);

        expect(stats.size).toBe(0);
        expect(engine.peak).toBe(0);
    });
});
