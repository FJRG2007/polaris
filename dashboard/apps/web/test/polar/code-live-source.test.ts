/**
 * The source a running session's model picker offers: the one it signs in with.
 */

import { describe, expect, it } from "vitest";
import { liveSourceFor, type CodeSource } from "@/lib/polar/agents/code-sources";

const source = (key: string, engines: string[]): CodeSource =>
    ({ key, engines, models: [] }) as unknown as CodeSource;

const sources = [
    source("account:a1", ["claude"]),
    source("machine:claude", ["claude"]),
    source("server:claude", ["claude"]),
    source("account:codex", ["codex"])
];

describe("the source a running session signs in with", () => {
    it("is its account when it picked one", () => {
        expect(liveSourceFor(sources, { cli: "claude", accountId: "a1", useMachineLogin: false })?.key).toBe("account:a1");
    });

    it("is the machine's sign-in, then the deployment's, otherwise", () => {
        expect(liveSourceFor(sources, { cli: "claude", accountId: null, useMachineLogin: true })?.key).toBe("machine:claude");
        expect(liveSourceFor(sources.slice(2), { cli: "claude", accountId: null, useMachineLogin: false })?.key).toBe("server:claude");
    });

    it("is none when that source is not listed or runs another tool", () => {
        expect(liveSourceFor(sources, { cli: "claude", accountId: "gone", useMachineLogin: false })).toBeNull();
        expect(liveSourceFor(sources, { cli: "claude", accountId: "codex", useMachineLogin: false })).toBeNull();
    });
});
