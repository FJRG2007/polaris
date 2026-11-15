/**
 * Lab performance: the container's one summary line is all that is read, a
 * hostname a public audit cannot reach is never audited, a site gets one check
 * at a time, the limited edition refuses instead of queueing, and a container
 * that never finishes is stopped and recorded as a timeout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let docker = true;
let busy = 0;
const created: unknown[] = [];

vi.mock("@polaris/config", () => ({ getCapabilities: () => ({ docker }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsLabRun: {
            count: async () => busy,
            createMany: async (args: unknown) => created.push(args)
        }
    }
}));

import * as lab from "@/lib/analytics-lab";

beforeEach(() => {
    docker = true;
    busy = 0;
    created.length = 0;
});

describe("the audit's summary line", () => {
    it("reads the figures and rounds them", () => {
        const log = [
            "some chrome noise",
            'POLARIS_LH {"performance":87.4,"accessibility":100,"bestPractices":92,"seo":null,"lcp":2412.7,"cls":0.04321,"tbt":120.2,"fcp":900,"si":1500,"tti":3000,"version":"12.6.0"}'
        ].join("\n");
        expect(lab.parseLabSummary(log)).toEqual({
            performance: 87,
            accessibility: 100,
            bestPractices: 92,
            seo: null,
            lcpMs: 2413,
            cls: 0.043,
            tbtMs: 120,
            fcpMs: 900,
            siMs: 1500,
            ttiMs: 3000,
            lighthouseVersion: "12.6.0"
        });
    });

    it("tells why it gave up, and treats anything else as a failed audit", () => {
        expect(lab.parseLabSummary('POLARIS_LH {"error":"unreachable"}')).toEqual({ error: "unreachable" });
        expect(lab.parseLabSummary("no summary at all")).toEqual({ error: "failed" });
        expect(lab.parseLabSummary("POLARIS_LH {not json")).toEqual({ error: "failed" });
        expect(lab.parseLabSummary('POLARIS_LH {"error":"rm -rf"}')).toEqual({ error: "failed" });
    });
});

describe("what is audited", () => {
    it("opens the first public hostname's home page", () => {
        expect(lab.labUrl(["Shop.Example.com", "other.example.org"])).toBe("https://shop.example.com/");
    });

    it("never audits an address, a single label or a local name", () => {
        expect(lab.labUrl([])).toBeNull();
        expect(lab.labUrl(["10.0.0.5"])).toBeNull();
        expect(lab.labUrl(["router"])).toBeNull();
        expect(lab.labUrl(["nas.lan"])).toBeNull();
        expect(lab.labUrl(["printer.home.arpa"])).toBeNull();
        expect(lab.labUrl(["evil.com/$(id)"])).toBeNull();
    });

    it("keeps the URL out of the command line and sets the desktop preset only for desktop", () => {
        const spec = lab.labSpec("0192-ABCD", "https://shop.example.com/", "desktop");
        const service = spec.services[0]!;
        expect(service.image).toBe(lab.LAB_IMAGE);
        expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
        expect(service.restart).toBe("no");
        expect(service.command!.join(" ")).not.toContain("shop.example.com");
        expect(service.env.POLARIS_LH_URL).toBe("https://shop.example.com/");
        expect(service.env.POLARIS_LH_PRESET).toBe("--preset=desktop");
        expect(lab.labSpec("x", "https://a.example/", "mobile").services[0]!.env.POLARIS_LH_PRESET).toBe("");
        expect(spec.project).toBe("polaris-lab-0192abcd");
        for (const value of Object.values(service.env)) expect(value).not.toMatch(/[\u0000-\u001f]/);
    });

    it("keeps the summarizer free of single quotes, so the shell passes it whole", () => {
        const script = lab.labScript();
        const body = script.slice(script.indexOf("node -e '") + "node -e '".length, -1);
        expect(body).not.toContain("'");
    });
});

describe("queueing a check", () => {
    it("queues mobile and desktop together", async () => {
        expect(await lab.queueLabCheck("site", ["a.example.com"], "manual")).toEqual({ queued: 2 });
        const data = (created[0] as { data: { strategy: string }[] }).data;
        expect(data.map((row) => row.strategy)).toEqual(["mobile", "desktop"]);
    });

    it("refuses a second check while one is waiting or running", async () => {
        busy = 1;
        expect(await lab.queueLabCheck("site", ["a.example.com"], "manual")).toEqual({ refused: "busy" });
        expect(created).toHaveLength(0);
    });

    it("refuses without the host daemon, and without a hostname", async () => {
        expect(await lab.queueLabCheck("site", [], "manual")).toEqual({ refused: "noUrl" });
        docker = false;
        expect(await lab.queueLabCheck("site", ["a.example.com"], "manual")).toEqual({ refused: "limited" });
    });
});

describe("running the container", () => {
    function ports(states: string[], log = 'POLARIS_LH {"error":"failed"}') {
        const calls: string[] = [];
        return {
            calls,
            ports: {
                composeUp: async () => void calls.push("up"),
                composeDown: async () => void calls.push("down"),
                inspect: async () => {
                    const status = states.length > 1 ? states.shift()! : states[0]!;
                    return { State: { Status: status, ExitCode: 0 } };
                },
                logs: async (_name: string, sink: (chunk: string) => void) => sink(log)
            } as never
        };
    }

    it("reads the summary once the container exits, and removes it", async () => {
        const fake = ports(["running", "exited"], 'POLARIS_LH {"performance":50,"accessibility":null,"bestPractices":null,"seo":null,"lcp":null,"cls":null,"tbt":null,"fcp":null,"si":null,"tti":null,"version":null}');
        const result = await lab.runLabContainer(fake.ports, "r1", "https://a.example/", "mobile", async () => undefined);
        expect(result).toMatchObject({ performance: 50 });
        expect(fake.calls.at(-1)).toBe("down");
    });

    it("stops a container that runs past the limit", async () => {
        const fake = ports(["running"]);
        const result = await lab.runLabContainer(fake.ports, "r2", "https://a.example/", "mobile", async () => undefined, -1);
        expect(result).toEqual({ error: "timeout" });
        expect(fake.calls.at(-1)).toBe("down");
    });
});

describe("the schedule", () => {
    it("moves a whole period on, and stops when off", () => {
        const from = Date.UTC(2026, 10, 15);
        expect(lab.nextLabAt("daily", from)?.getTime()).toBe(from + 86_400_000);
        expect(lab.nextLabAt("weekly", from)?.getTime()).toBe(from + 7 * 86_400_000);
        expect(lab.nextLabAt("off", from)).toBeNull();
    });
});
