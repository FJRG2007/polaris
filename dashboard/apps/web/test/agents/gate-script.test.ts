/**
 * The pre-push hook Polaris renders for a run.
 *
 * Two things matter here and neither is visible by reading the template. The
 * script is bash that runs on somebody else's machine, so it has to parse - a
 * quoting mistake is a run that dies at the push with a syntax error instead of a
 * verdict. And the operator's own prose is interpolated into it, so an apostrophe
 * in "don't break the exporter" must stay inside the quotes rather than ending
 * them and turning the rest of a sentence into commands.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { gateScript, parseGateSteps } from "@/lib/agents/agent-gate";

const BASE = {
    apiUrl: "https://polaris.example",
    runId: "0192f4c3-0000-7000-8000-000000000000",
    runToken: "a-run-token",
    intent: "Add a regression test"
};

/** Whether bash accepts the script. `-n` parses without running any of it. */
function parses(script: string): boolean {
    const path = join(mkdtempSync(join(tmpdir(), "gate-")), "hook.sh");
    writeFileSync(path, script);
    try {
        execFileSync("bash", ["-n", path], { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

describe("gateScript", () => {
    it("renders nothing when the gate is off", () => {
        expect(gateScript({ ...BASE, mode: "off" })).toBeNull();
    });

    it("produces a script bash accepts", () => {
        expect(parses(gateScript({ ...BASE, mode: "checks" }) as string)).toBe(true);
        expect(parses(gateScript({ ...BASE, mode: "full" }) as string)).toBe(true);
    });

    it("still parses with an apostrophe in the operator's intent", () => {
        const script = gateScript({
            ...BASE,
            mode: "full",
            intent: "Don't break the exporter; it's what the whole report runs on"
        }) as string;
        expect(parses(script)).toBe(true);
    });

    it("keeps a quote-breaking intent inside its quotes", () => {
        // The failure this guards: an intent that closes the quoting and appends
        // a command would run that command on the operator's machine.
        const script = gateScript({ ...BASE, mode: "full", intent: "' ; touch /tmp/pwned ; echo '" }) as string;
        expect(parses(script)).toBe(true);
        expect(script).not.toContain("; touch /tmp/pwned ;\n");
    });

    it("runs the deterministic check in both modes and the full gate in only one", () => {
        const checks = gateScript({ ...BASE, mode: "checks" }) as string;
        const full = gateScript({ ...BASE, mode: "full" }) as string;
        expect(checks).toContain("gate_step verify");
        expect(checks).not.toContain("gate axi run");
        expect(full).toContain("gate_step verify");
        expect(full).toContain("gate axi run");
    });

    it("never lets the gate open its own push or pull request", () => {
        // The runtime owns both; a gate that opened its own would leave two.
        expect(gateScript({ ...BASE, mode: "full" })).toContain("--skip push,pr,ci");
    });

    it("reports steps against the run that owns them", () => {
        expect(gateScript({ ...BASE, mode: "checks" })).toContain(`/api/agents/runs/${BASE.runId}/gate`);
    });
});

describe("parseGateSteps", () => {
    it("reads back what a run reported", () => {
        const stored = JSON.stringify([{ step: "verify", state: "passed", detail: null, at: "2026-08-08T00:00:00.000Z" }]);
        expect(parseGateSteps(stored)).toHaveLength(1);
    });

    it("drops a step this version does not know, rather than rendering it", () => {
        const stored = JSON.stringify([
            { step: "teleport", state: "passed", detail: null, at: "2026-08-08T00:00:00.000Z" },
            { step: "verify", state: "sideways", detail: null, at: "2026-08-08T00:00:00.000Z" }
        ]);
        expect(parseGateSteps(stored)).toEqual([]);
    });

    it("treats an unreadable value as no steps", () => {
        expect(parseGateSteps("not json")).toEqual([]);
        expect(parseGateSteps(null)).toEqual([]);
    });
});
