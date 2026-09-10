/**
 * A release counts only once it is serving, and a swarm update never has a gap.
 *
 * Before the gate, a container that started and immediately exited was recorded
 * as a successful deploy and promoted, which moved the edge onto a dead service.
 * These pin the verdicts: exited, crash-looping and unhealthy fail with a reason;
 * healthy and steadily running pass; a machine that cannot report state is not
 * held up. The clock is injected, so nothing here actually waits. And a release
 * standing beside the one it replaces answers to the service's own name.
 */

import { describe, expect, it, vi } from "vitest";
import { ComposeRuntime } from "../src/runtime/compose.js";
import type { AppDeployPlan, RuntimeContext } from "../src/runtime/driver.js";
import { readinessDeadlineMs, waitUntilServing } from "../src/runtime/readiness.js";
import { forSwarm, renderComposeYaml, type ComposeSpec } from "../src/compose-spec.js";

/** A context whose inspect answers each call with the next state in `states`. */
function context(states: unknown[]) {
    let call = 0;
    const ctx = {
        ports: {
            inspect: async () => states[Math.min(call++, states.length - 1)],
            logs: async () => undefined
        },
        target: { id: "local", kind: "local", engine: "compose", proxyNetwork: "polaris" },
        log: () => undefined
    } as unknown as RuntimeContext;
    return ctx;
}

function fakeClock(start = Date.parse("2026-09-10T10:00:00Z")) {
    let now = start;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

const container = (state: Record<string, unknown>, restarts = 0) => ({
    RestartCount: restarts,
    State: state
});

describe("waiting for a release to come up", () => {
    it("fails a container that exits, naming its exit code", async () => {
        const result = await waitUntilServing(
            context([container({ Status: "exited", ExitCode: 1 })]),
            "web",
            {},
            fakeClock()
        );
        expect(result).toEqual({ ok: false, reason: expect.stringContaining("exit code 1") });
    });

    it("fails one that keeps restarting", async () => {
        const started = "2026-09-10T10:00:00Z";
        const result = await waitUntilServing(
            context([
                container({ Status: "running", StartedAt: started }, 0),
                container({ Status: "running", StartedAt: started }, 1)
            ]),
            "web",
            {},
            fakeClock()
        );
        expect(result).toEqual({ ok: false, reason: "the new version keeps restarting" });
    });

    it("waits for a healthcheck, and fails an unhealthy one", async () => {
        const plan = { healthcheck: { test: ["CMD", "true"], intervalSeconds: 5, retries: 2 } };
        const healthy = await waitUntilServing(
            context([
                container({ Status: "running", Health: { Status: "starting" } }),
                container({ Status: "running", Health: { Status: "healthy" } })
            ]),
            "web",
            plan,
            fakeClock()
        );
        expect(healthy).toEqual({ ok: true });
        const unhealthy = await waitUntilServing(
            context([container({ Status: "running", Health: { Status: "unhealthy" } })]),
            "web",
            plan,
            fakeClock()
        );
        expect(unhealthy.ok).toBe(false);
    });

    it("passes a container with no healthcheck once it has stayed up", async () => {
        const clock = fakeClock();
        const result = await waitUntilServing(
            context([
                container({ Status: "running", StartedAt: new Date(clock.now()).toISOString() })
            ]),
            "web",
            {},
            clock
        );
        expect(result).toEqual({ ok: true });
    });

    it("does not hold up a machine that cannot say what state it is in", async () => {
        expect(await waitUntilServing(context([{}]), "web", {}, fakeClock())).toEqual({ ok: true });
    });

    it("bounds the wait by the healthcheck's own worst case", () => {
        expect(readinessDeadlineMs({})).toBe(45_000);
        expect(
            readinessDeadlineMs({
                healthcheck: {
                    test: ["CMD", "true"],
                    intervalSeconds: 10,
                    retries: 3,
                    startPeriodSeconds: 20
                }
            })
        ).toBe(20_000 + 40_000 + 15_000);
    });
});

describe("a swarm update", () => {
    const spec = (volumes: ComposeSpec["services"][number]["volumes"]): ComposeSpec => ({
        project: "p",
        services: [
            { name: "web", image: "nginx", env: {}, ports: [], volumes, labels: {}, networks: [] }
        ],
        volumes: [],
        networks: []
    });

    it("starts the new task first and rolls itself back", () => {
        const yaml = renderComposeYaml(forSwarm(spec([])), "/v", "/m");
        expect(yaml).toContain("order: start-first");
        expect(yaml).toContain("failure_action: rollback");
    });

    it("keeps stop-first for a service with a volume, so two tasks never share its files", () => {
        const yaml = renderComposeYaml(
            forSwarm(spec([{ source: "data", target: "/data", kind: "volume" }])),
            "/v",
            "/m"
        );
        expect(yaml).not.toContain("start-first");
    });
});

describe("a release beside the one it replaces", () => {
    const service = (aliases?: string[]): ComposeSpec => ({
        project: "p-abc1234",
        services: [
            {
                name: "web-abc1234",
                image: "nginx",
                env: {},
                ports: [],
                volumes: [],
                labels: {},
                networks: ["polaris-proxy", "hub"],
                ...(aliases ? { aliases } : {})
            }
        ],
        volumes: [],
        networks: ["polaris-proxy", "hub"]
    });

    it("answers to the service's own name on every network it joins", () => {
        const yaml = renderComposeYaml(service(["web"]), "/v", "/m");
        expect(yaml).toContain(
            '      polaris-proxy:\n        aliases:\n          - "web"\n      hub:\n        aliases:\n          - "web"'
        );
    });

    it("keeps the plain network list when it carries no alias", () => {
        const yaml = renderComposeYaml(service(), "/v", "/m");
        expect(yaml).toContain("    networks:\n      - polaris-proxy\n      - hub");
    });
});

describe("a release of several copies beside the one it replaces", () => {
    const plan = {
        ref: { name: "web-abc1234", project: "p-abc1234" },
        alias: "web",
        build: { method: "image", name: "web", contextPath: ".", imageRef: "nginx:1" },
        env: {},
        replicas: 3,
        private: true,
        domains: [],
        volumes: []
    } as unknown as AppDeployPlan;

    /** A machine where every copy has been running a while, except the ones named. */
    function machine(exited: readonly string[] = []) {
        const asked: string[] = [];
        const ports = {
            pull: vi.fn(async () => undefined),
            composeUp: vi.fn(async () => undefined),
            inspectImage: vi.fn(async () => [] as number[]),
            logs: vi.fn(async () => undefined),
            inspect: vi.fn(async (name: string) => {
                asked.push(name);
                return exited.includes(name)
                    ? container({ Status: "exited", ExitCode: 1 })
                    : container({ Status: "running", StartedAt: "2026-09-10T09:00:00Z" });
            })
        };
        const ctx = {
            ports,
            target: { id: "t1", kind: "host", engine: "compose", proxyNetwork: "polaris-proxy" },
            log: () => undefined
        } as unknown as RuntimeContext;
        return { ctx, ports, asked };
    }

    it("starts every copy under the release's names and waits for each before it counts", async () => {
        const { ctx, ports, asked } = machine();
        const result = await new ComposeRuntime().deployApplication(plan, ctx);
        expect(result.ok).toBe(true);
        const spec = ports.composeUp.mock.calls[0]?.[0] as unknown as ComposeSpec;
        expect(spec.project).toBe("p-abc1234");
        expect(spec.services.map((service) => service.aliases)).toEqual([
            ["web"],
            ["web", "web-abc1234", "web-r2"],
            ["web", "web-abc1234", "web-r3"]
        ]);
        expect([...new Set(asked)]).toEqual(["web-abc1234", "web-abc1234-r2", "web-abc1234-r3"]);
    });

    it("fails the whole release when one copy does not come up, so the old one keeps serving", async () => {
        const { ctx } = machine(["web-abc1234-r3"]);
        const result = await new ComposeRuntime().deployApplication(plan, ctx);
        expect(result).toEqual({ ok: false, error: expect.stringContaining("exit code 1") });
    });
});
