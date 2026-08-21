/**
 * A deploy that fails has to say so in the log.
 *
 * This is a real afternoon: an app was deployed, every line of the build log
 * read as success, the image was built and tagged, and the deployment came back
 * red with nothing to read. The reason - a NAS that had gone off the network -
 * was returned by the runtime and stored on the record, and the log simply
 * stopped mid-step, because a step that throws never writes its closing line.
 *
 * Whoever is looking at a failed deploy is looking at the log. So the reason
 * goes there, and these pin that for every way this runtime can give up.
 */

import { describe, expect, it, vi } from "vitest";
import { ComposeRuntime } from "../src/runtime/compose.js";
import type { AppDeployPlan, MountTarget, RuntimeContext } from "../src/runtime/driver.js";

/** A context that records the log rather than streaming it anywhere. */
function contextWith(overrides: Partial<RuntimeContext["ports"]> = {}) {
    const lines: string[] = [];
    const ports = {
        pull: vi.fn(async () => undefined),
        build: vi.fn(async () => undefined),
        composeUp: vi.fn(async () => undefined),
        composeDown: vi.fn(async () => undefined),
        ensureMount: vi.fn(async () => true),
        inspectImage: vi.fn(async () => [] as number[]),
        ...overrides
    } as unknown as RuntimeContext["ports"];
    const ctx = {
        ports,
        target: { id: "t1", proxyNetwork: "polaris-proxy" },
        log: (chunk: Buffer) => {
            lines.push(chunk.toString());
        }
    } as unknown as RuntimeContext;
    return { ctx, lines, ports };
}

const MOUNT: MountTarget = {
    id: "117044d3-1dcb-8b1f-9f0e-cca6e3b24332",
    kind: "smb",
    source: "//192.168.1.145/Personal-Drive"
} as MountTarget;

function planWithMount(): AppDeployPlan {
    return {
        ref: { name: "orphion", project: "polaris-abcd1234" },
        build: { method: "image", name: "orphion", contextPath: "/ctx", imageRef: "ghcr.io/acme/orphion:latest" },
        env: {},
        replicas: 1,
        domains: [],
        volumes: [],
        mounts: [MOUNT]
    } as unknown as AppDeployPlan;
}

describe("a deploy that gives up", () => {
    it("writes the reason a share could not be mounted", async () => {
        const { ctx, lines } = contextWith({
            ensureMount: vi.fn(async () => {
                throw new Error("SMB connection failed: connect EHOSTUNREACH 192.168.1.145:445");
            })
        } as Partial<RuntimeContext["ports"]>);

        const result = await new ComposeRuntime().deployApplication(planWithMount(), ctx);

        expect(result.ok).toBe(false);
        const log = lines.join("");
        // The step is announced, and then the reason follows it. Before this,
        // the announcement was the last line anybody saw.
        expect(log).toContain("Mounting SMB //192.168.1.145/Personal-Drive");
        expect(log).toContain("Failed: could not mount a NAS volume");
        expect(log).toContain("EHOSTUNREACH 192.168.1.145:445");
    });

    it("never starts the containers when the share it needs is not there", async () => {
        // The share is what the app's data lives on. A container brought up
        // without it writes into an empty directory on the host and looks fine
        // until somebody goes looking for the files.
        const { ctx, ports } = contextWith({
            ensureMount: vi.fn(async () => {
                throw new Error("mount error: Server abruptly closed the connection");
            })
        } as Partial<RuntimeContext["ports"]>);

        await new ComposeRuntime().deployApplication(planWithMount(), ctx);
        expect(ports.composeUp).not.toHaveBeenCalled();
    });

    it("writes the reason the containers would not start", async () => {
        const { ctx, lines } = contextWith({
            composeUp: vi.fn(async () => {
                throw new Error("network polaris-proxy not found");
            })
        } as Partial<RuntimeContext["ports"]>);

        const result = await new ComposeRuntime().deployApplication(planWithMount(), ctx);

        expect(result.ok).toBe(false);
        expect(lines.join("")).toContain("Failed: network polaris-proxy not found");
    });

    it("says something even when what was thrown says nothing", async () => {
        const { ctx, lines } = contextWith({
            composeUp: vi.fn(async () => {
                throw new Error("");
            })
        } as Partial<RuntimeContext["ports"]>);

        await new ComposeRuntime().deployApplication(planWithMount(), ctx);
        expect(lines.join("")).toContain("Failed: compose up failed");
    });
});
