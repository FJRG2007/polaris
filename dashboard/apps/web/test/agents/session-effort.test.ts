/**
 * The effort a Code session starts at and changes to: the flag on the launch
 * line, the command typed mid-session, and the boot script's relaunch.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as commands from "@/lib/agents/session-commands";

describe("agentEffortArgs: the CLI flags built for Code", () => {
    it("gives Claude Code --effort at a level it lists", () => {
        expect(core.agentEffortArgs("claude", "high")).toEqual(["--effort", "high"]);
        expect(core.agentEffortArgs("claude", "max")).toEqual(["--effort", "max"]);
        expect(core.agentEffortLevels("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    });

    it("gives nothing for no level, an unknown level, or a tool without an effort flag", () => {
        expect(core.agentEffortArgs("claude", null)).toEqual([]);
        expect(core.agentEffortArgs("claude", "ultra; rm -rf /")).toEqual([]);
        expect(core.agentEffortArgs("codex", "high")).toEqual([]);
        expect(core.agentEffortLevels("codex")).toEqual([]);
        expect(core.agentEffortArgs("nope", "high")).toEqual([]);
    });

    it("accepts effort on a start and defaults it to none", () => {
        const base = { repoId: null, title: "t", cli: "claude", place: "local" };
        expect(core.startAgentSessionSchema.safeParse(base).data?.effort).toBeNull();
        expect(core.startAgentSessionSchema.safeParse({ ...base, effort: "xhigh" }).data?.effort).toBe("xhigh");
        expect(core.startAgentSessionSchema.safeParse({ ...base, effort: "loud" }).success).toBe(false);
    });
});

describe("effortCommand: a change mid-session", () => {
    it("keeps the level for the next start and types /effort", () => {
        const script = commands.effortCommand("/state", "/effort", "xhigh");
        expect(script).toContain("printf %s 'xhigh' > \"/state/effort\"");
        expect(script).toContain("-l '/effort xhigh'");
    });

    it("refuses anything that is not a level or a command", () => {
        expect(() => commands.effortCommand("/state", "/effort", "high; reboot")).toThrow();
        expect(() => commands.effortCommand("/state", "rm -rf", "high")).toThrow();
    });

    it("relaunches with the kept level, only when it is a known one", () => {
        const boot = commands.LAUNCH_SCRIPT;
        expect(boot).toContain('"$POLARIS_STATE_DIR/effort"');
        expect(boot).toContain('low|medium|high|xhigh|max) line="$line --effort $m"');
    });
});
