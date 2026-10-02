/**
 * A release counts as up only once it accepts connections on the port the edge
 * will dial, read from the container's own socket tables - and the compose
 * runtime does its steps in an order that never puts an unready release in front
 * of anyone: fetch, start, wait for it to run, wait for its port, and only then
 * report success to the pipeline that moves the edge.
 *
 * Also the spec a change-over release with shared volumes and a service on the
 * operator's own network are started with: the service's named volumes by their
 * exact names, external; and the names it answers to there on that network only.
 */

import { describe, expect, it, vi } from "vitest";
import { ComposeRuntime } from "../src/runtime/compose.js";
import { appComposeSpec, renderComposeYaml } from "../src/compose-spec.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";
import { portStateFrom, waitUntilListening } from "../src/runtime/readiness.js";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const HEADER6 =
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
/** One socket row: port 3000 is 0BB8. */
const v4 = (address: string, port: string, state = "0A") =>
    `   0: ${address}:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;
const v6 = (address: string, port: string) =>
    `   0: ${address}:${port} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;

function fakeClock(start = 0) {
    let now = start;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("reading a container's sockets", () => {
    it("finds a socket listening on every address", () => {
        expect(portStateFrom([HEADER, v4("00000000", "0BB8")].join("\n"), 3000)).toBe("listening");
        expect(portStateFrom([HEADER6, v6("00000000000000000000000000000000", "0BB8")].join("\n"), 3000)).toBe("listening");
    });

    it("tells a socket bound to localhost only apart from one nothing listens on", () => {
        expect(portStateFrom([HEADER, v4("0100007F", "0BB8")].join("\n"), 3000)).toBe("loopback");
        expect(portStateFrom([HEADER6, v6("00000000000000000000000001000000", "0BB8")].join("\n"), 3000)).toBe("loopback");
        expect(portStateFrom([HEADER, v4("00000000", "1F90")].join("\n"), 3000)).toBe("closed");
    });

    it("counts only a listening socket, not a connection on that port", () => {
        expect(portStateFrom([HEADER, v4("00000000", "0BB8", "01")].join("\n"), 3000)).toBe("closed");
    });
});

describe("waiting for a release's port", () => {
    function ctx(reads: string[]) {
        let call = 0;
        return {
            ports: { runIn: vi.fn(async () => ({ code: 0, output: reads[Math.min(call++, reads.length - 1)] })) },
            log: () => undefined
        } as unknown as RuntimeContext;
    }

    it("waits until the port opens", async () => {
        const result = await waitUntilListening(
            ctx([HEADER, HEADER, [HEADER, v4("00000000", "0BB8")].join("\n")]),
            "web",
            3000,
            fakeClock()
        );
        expect(result).toEqual({ ok: true });
    });

    it("fails a release bound to localhost, saying so", async () => {
        const result = await waitUntilListening(ctx([[HEADER, v4("0100007F", "0BB8")].join("\n")]), "web", 3000, fakeClock());
        expect(result).toEqual({ ok: false, reason: expect.stringContaining("localhost only") });
    });

    it("fails one that never opens the port within the deadline", async () => {
        const result = await waitUntilListening(ctx([HEADER]), "web", 3000, fakeClock(), 10_000);
        expect(result).toEqual({ ok: false, reason: expect.stringContaining("did not start listening on port 3000") });
    });

    it("does not hold up an image it cannot look into", async () => {
        const result = await waitUntilListening(
            ctx(['OCI runtime exec failed: exec: "cat": executable file not found in $PATH']),
            "web",
            3000,
            fakeClock()
        );
        expect(result).toEqual({ ok: true, unchecked: true });
    });

    it("asks again after a read that failed for any other reason", async () => {
        let call = 0;
        const runIn = vi.fn(async () => {
            call += 1;
            if (call === 1) throw new Error("container is restarting");
            if (call === 2) return { code: 1, output: "Error response from daemon: connection reset" };
            return { code: 0, output: [HEADER, v4("00000000", "0BB8")].join("\n") };
        });
        const context = { ports: { runIn }, log: () => undefined } as unknown as RuntimeContext;
        const result = await waitUntilListening(context, "web", 3000, fakeClock());
        expect(result).toEqual({ ok: true });
        expect(runIn).toHaveBeenCalledTimes(3);
    });

    it("fails, rather than passes, a container whose sockets never could be read", async () => {
        const runIn = vi.fn(async () => {
            throw new Error("ssh: connection lost");
        });
        const context = { ports: { runIn }, log: () => undefined } as unknown as RuntimeContext;
        const result = await waitUntilListening(context, "web", 3000, fakeClock(), 10_000);
        expect(result).toEqual({ ok: false, reason: expect.stringContaining("could not be read") });
    });
});

describe("the order a release is brought up in", () => {
    const plan = {
        ref: { name: "shop-abc1234", project: "polaris-1a2b3c4d-abc1234" },
        alias: "shop",
        build: { method: "image", name: "shop", contextPath: ".", imageRef: "nginx:1" },
        env: {},
        replicas: 1,
        private: true,
        awaitPort: true,
        expose: { host: 20001, container: 3000 },
        domains: [],
        volumes: []
    } as unknown as AppDeployPlan;

    function machine(opensAfter: number) {
        const ops: string[] = [];
        let reads = 0;
        const ports = {
            pull: vi.fn(async (image: string) => void ops.push(`pull ${image}`)),
            composeUp: vi.fn(async (spec: { project: string }) => void ops.push(`up ${spec.project}`)),
            inspectImage: vi.fn(async () => [] as number[]),
            logs: vi.fn(async () => undefined),
            inspect: vi.fn(async (name: string) => {
                ops.push(`inspect ${name}`);
                return { RestartCount: 0, State: { Status: "running", Health: { Status: "healthy" } } };
            }),
            runIn: vi.fn(async (name: string) => {
                reads += 1;
                ops.push(`sockets ${name}`);
                return { code: 0, output: reads > opensAfter ? [HEADER, v4("00000000", "0BB8")].join("\n") : HEADER };
            })
        };
        const context = {
            ports,
            target: { id: "t1", kind: "local", engine: "compose", proxyNetwork: "polaris-proxy" },
            log: () => undefined
        } as unknown as RuntimeContext;
        return { ops, context };
    }

    it("fetches, starts, waits for it to run, then for its port - and only then succeeds", async () => {
        vi.useFakeTimers();
        try {
            const { ops, context } = machine(2);
            const pending = new ComposeRuntime().deployApplication(plan, context);
            await vi.advanceTimersByTimeAsync(10_000);
            const result = await pending;
            expect(result.ok).toBe(true);
            const order = [...new Set(ops)];
            expect(order).toEqual([
                "pull nginx:1",
                "up polaris-1a2b3c4d-abc1234",
                "inspect shop-abc1234",
                "sockets shop-abc1234"
            ]);
            expect(ops.filter((op) => op.startsWith("sockets"))).toHaveLength(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("fails, without succeeding, a release whose port never opens", async () => {
        vi.useFakeTimers();
        try {
            const { context } = machine(Number.POSITIVE_INFINITY);
            const pending = new ComposeRuntime().deployApplication(plan, context);
            await vi.advanceTimersByTimeAsync(4 * 60_000);
            const result = await pending;
            expect(result).toEqual({ ok: false, error: expect.stringContaining("did not start listening on port 3000") });
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not wait on a port for a worker nothing is routed to", async () => {
        const { ops, context } = machine(Number.POSITIVE_INFINITY);
        const result = await new ComposeRuntime().deployApplication({ ...plan, awaitPort: false }, context);
        expect(result.ok).toBe(true);
        expect(ops.some((op) => op.startsWith("sockets"))).toBe(false);
    });
});

describe("what a release is started with", () => {
    const plan = {
        ref: { name: "shop-abc1234", project: "polaris-1a2b3c4d-abc1234" },
        alias: "shop",
        build: { method: "image", name: "shop", contextPath: ".", imageRef: "nginx:1" },
        env: {},
        replicas: 1,
        private: true,
        domains: [],
        volumes: [
            { mountPath: "/uploads", source: "uploads", kind: "volume" },
            { mountPath: "/media", source: "media", kind: "bind" }
        ]
    } as unknown as AppDeployPlan;

    it("mounts the service's own named volumes by their exact names when it shares them", () => {
        const spec = appComposeSpec({ ...plan, sharedVolumesFrom: "polaris-1a2b3c4d" }, "nginx:1", "polaris-proxy");
        expect(spec.volumes).toEqual([]);
        expect(spec.externalVolumes).toEqual(["polaris-1a2b3c4d_uploads"]);
        expect(spec.services[0]?.volumes).toEqual([
            { source: "polaris-1a2b3c4d_uploads", target: "/uploads", kind: "volume" },
            { source: "media", target: "/media", kind: "bind" }
        ]);
        const yaml = renderComposeYaml(spec, "/v", "/m");
        expect(yaml).toContain("  polaris-1a2b3c4d_uploads:\n    external: true");
    });

    it("owns its volumes as before when it does not share them", () => {
        const spec = appComposeSpec(plan, "nginx:1", "polaris-proxy");
        expect(spec.volumes).toEqual(["uploads"]);
        expect(spec.externalVolumes).toBeUndefined();
    });

    it("answers to every name it was given on the operator's network, and to none of them on the proxy network", () => {
        const spec = appComposeSpec(
            { ...plan, volumes: [], extraNetworks: ["app_network"], networkAliases: { app_network: ["dymo-api", "dymoapi"] } },
            "nginx:1",
            "polaris-proxy"
        );
        expect(spec.networks).toEqual(["polaris-proxy", "app_network"]);
        const yaml = renderComposeYaml(spec, "/v", "/m");
        expect(yaml).toContain(
            '      polaris-proxy:\n        aliases:\n          - "shop"\n      app_network:\n        aliases:\n          - "shop"\n          - "dymo-api"\n          - "dymoapi"'
        );
        // Declared external: Polaris never creates or removes it.
        expect(yaml).toContain("  app_network:\n    external: true");
    });

    it("drops names for a network it does not join", () => {
        const spec = appComposeSpec({ ...plan, volumes: [], networkAliases: { app_network: ["dymoapi"] } }, "nginx:1", "polaris-proxy");
        expect(spec.services[0]?.networkAliases).toBeUndefined();
    });
});
