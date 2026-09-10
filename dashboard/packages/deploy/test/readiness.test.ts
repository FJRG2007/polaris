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

import { describe, expect, it } from "vitest";
import type { RuntimeContext } from "../src/runtime/driver.js";
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

const container = (state: Record<string, unknown>, restarts = 0) => ({ RestartCount: restarts, State: state });

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
            context([container({ Status: "running", StartedAt: new Date(clock.now()).toISOString() })]),
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
            readinessDeadlineMs({ healthcheck: { test: ["CMD", "true"], intervalSeconds: 10, retries: 3, startPeriodSeconds: 20 } })
        ).toBe(20_000 + 40_000 + 15_000);
    });
});

describe("a swarm update", () => {
    const spec = (volumes: ComposeSpec["services"][number]["volumes"]): ComposeSpec => ({
        project: "p",
        services: [{ name: "web", image: "nginx", env: {}, ports: [], volumes, labels: {}, networks: [] }],
        volumes: [],
        networks: []
    });

    it("starts the new task first and rolls itself back", () => {
        const yaml = renderComposeYaml(forSwarm(spec([])), "/v", "/m");
        expect(yaml).toContain("order: start-first");
        expect(yaml).toContain("failure_action: rollback");
    });

    it("keeps stop-first for a service with a volume, so two tasks never share its files", () => {
        const yaml = renderComposeYaml(forSwarm(spec([{ source: "data", target: "/data", kind: "volume" }])), "/v", "/m");
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
        expect(yaml).toContain('      polaris-proxy:\n        aliases:\n          - "web"\n      hub:\n        aliases:\n          - "web"');
    });

    it("keeps the plain network list when it carries no alias", () => {
        const yaml = renderComposeYaml(service(), "/v", "/m");
        expect(yaml).toContain("    networks:\n      - polaris-proxy\n      - hub");
    });
});
