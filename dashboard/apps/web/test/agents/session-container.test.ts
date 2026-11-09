import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capabilities = { privateNetworks: true };
const ups: { networks: string[]; service: string[] }[] = [];
const refuse = { network: false };

vi.mock("@polaris/config", async (original) => ({
    ...(await original<typeof import("@polaris/config")>()),
    getCapabilities: () => capabilities
}));
vi.mock("@/lib/agents/session-capacity", () => ({ sessionLimits: async () => ({ cpus: 2, memoryMb: 2048 }) }));
vi.mock("@/lib/agents/session-image", () => ({
    upWithFreshImage: async (up: (policy: string) => Promise<void>) => up("missing")
}));
vi.mock("@/lib/agents/session-ports", () => ({
    withContainerPorts: async (_host: string | null, work: (ports: unknown) => Promise<unknown>) =>
        work({
            composeUp: async (spec: { networks: string[]; services: { networks: string[] }[] }) => {
                ups.push({ networks: spec.networks, service: spec.services[0]!.networks });
                if (refuse.network && spec.networks.length > 0) {
                    throw new Error("deploy up failed (502): could not create network polaris-net-sabc: no address range left");
                }
            }
        })
}));

const container = await import("@/lib/agents/session-container");
const commands = await import("@/lib/agents/session-commands");
const network = await import("@/lib/agents/session-network");
const ID = "00000000-0000-4000-8000-00000000c001";
const target = { id: ID, hostId: null, ownerId: "00000000-0000-4000-8000-00000000c002", sharedHome: false };

describe("the network a session's container joins", () => {
    beforeEach(() => {
        ups.length = 0;
        capabilities.privateNetworks = true;
        refuse.network = false;
    });

    it("is a private network of its own on this box, in the shape the daemon makes", () => {
        const [name] = network.sessionNetworks(target);
        expect(name).toMatch(/^polaris-net-s[a-f0-9]{10}$/);
        expect(network.sessionNetwork("00000000-0000-4000-8000-00000000c003")).not.toBe(name);
    });

    it("is none on a pool server, or where the daemon makes no private networks", () => {
        expect(network.sessionNetworks({ ...target, hostId: "00000000-0000-4000-8000-00000000c004" })).toEqual([]);
        capabilities.privateNetworks = false;
        expect(network.sessionNetworks(target)).toEqual([]);
    });

    it("is joined by the container, and left out when the box has no range left for it", async () => {
        await container.startContainer(target, {}, "true");
        expect(ups).toEqual([{ networks: [network.sessionNetwork(ID)], service: [network.sessionNetwork(ID)] }]);

        ups.length = 0;
        refuse.network = true;
        await container.startContainer(target, {}, "true");
        expect(ups.map((up) => up.networks)).toEqual([[network.sessionNetwork(ID)], []]);
    });
});

describe("what Claude Code is told about the preview", () => {
    it("holds nothing the launch line would read as its own quoting", () => {
        const text = commands.PREVIEW_PROMPT.replace("${POLARIS_PREVIEW_BASE}", "");
        expect(text).not.toMatch(/["`\\$]/);
    });

    it.runIf(process.platform !== "win32")("reaches the agent as one argument, with the session's path in it", () => {
        const lines = commands.LAUNCH_SCRIPT.split("\n");
        const start = lines.findIndex((line) => line.startsWith('if [ "$POLARIS_AGENT_CONFIG" = "claude" ]'));
        const block = lines.slice(start, start + 4).join("\n");
        const script = `line=claude\n${block}\nsh -c "printf '%s\\n' $line"`;
        const result = spawnSync("/bin/sh", ["-c", script], {
            env: {
                PATH: "/usr/bin:/bin",
                POLARIS_AGENT_CONFIG: "claude",
                POLARIS_STATE_DIR: "/session/polaris",
                POLARIS_PREVIEW_BASE: "/api/agents/preview/x/sig"
            },
            encoding: "utf8"
        });
        const argv = result.stdout.trim().split("\n");
        const at = argv.indexOf("--append-system-prompt");
        expect(at).toBeGreaterThan(0);
        expect(argv[at + 1]).toContain("/api/agents/preview/x/sig/N/");
        expect(argv[at + 1]).toBe(commands.PREVIEW_PROMPT.replace("${POLARIS_PREVIEW_BASE}", "/api/agents/preview/x/sig"));
    });
});
