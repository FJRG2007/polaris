/**
 * The Enigma quality gate, in the one place a run can be stopped and told why.
 *
 * A run's work is committed by the agent and then pushed by the runtime, and the
 * runtime runs a pre-push hook in between. That is where this goes: the commits
 * exist (so there is something to review), nothing has left the machine yet (so a
 * refusal is still cheap), and a hook that exits non-zero blocks the push and
 * hands its output back to the agent as something to fix rather than to a log
 * nobody opens.
 *
 * The script is rendered per run rather than kept as a file in the repository:
 * the mode is an operator setting three tiers deep, and a repository that carried
 * its own copy would drift from the screen that configured it.
 *
 * It reports each step back as it goes, so the run screen shows the pipeline
 * working instead of a spinner. The token that authorizes those calls is
 * interpolated into the script, which is delivered inside the run-context reply -
 * the same authenticated response that already carries the run's API token, so
 * this widens nothing.
 */

import type { AgentGateMode } from "@polaris/core";

/**
 * The version of Enigma a run installs and gates with.
 *
 * Pinned rather than `latest` so two runs of the same repository work to the same
 * standards, and so a release upstream cannot change what a repository's gate
 * accepts without anybody here choosing it.
 */
export const ENIGMA_VERSION = "1.35.2";

/**
 * The steps a run reports, in the order the gate runs them.
 *
 * Named for what the operator is watching rather than for the command behind
 * each one. `verify` is the deterministic half - it reads the change for work
 * reported as finished that is not, sweeps the lines the agent added for
 * convention violations, and runs the project's own verification command.
 * `review` is the full gate, which drives its own review, test and document
 * passes and prints its own progress.
 */
export const GATE_STEPS = ["verify", "review"] as const;
export type GateStep = (typeof GATE_STEPS)[number];

export const GATE_STEP_LABELS: Record<GateStep, string> = {
    verify: "Verification",
    review: "Review, tests and docs"
};

/** Where one step got to. */
export const GATE_STEP_STATES = ["running", "passed", "failed"] as const;
export type GateStepState = (typeof GATE_STEP_STATES)[number];

export interface GateStepReport {
    step: GateStep;
    state: GateStepState;
    /** What it said, when it has something worth showing. */
    detail: string | null;
    /** ISO 8601, stamped when Polaris received it. */
    at: string;
}

/** Read a stored step list back, keeping only what this version understands. A
 *  malformed value is no steps rather than a broken screen. */
export function parseGateSteps(stored: string | null): GateStepReport[] {
    if (!stored) return [];
    try {
        const parsed: unknown = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (row): row is GateStepReport =>
                typeof row === "object" &&
                row !== null &&
                GATE_STEPS.includes((row as GateStepReport).step) &&
                GATE_STEP_STATES.includes((row as GateStepReport).state)
        );
    } catch {
        return [];
    }
}

export interface GateScriptInput {
    mode: AgentGateMode;
    /** Where the steps are reported. Already stripped of a trailing slash. */
    apiUrl: string;
    /** The run these steps belong to. */
    runId: string;
    /** Authorizes the step reports. Scoped to this run and dead once it ends. */
    runToken: string;
    /** What the operator set out to accomplish, which is what the gate's review
     *  pass uses to tell a deliberate choice from a mistake. */
    intent: string;
}

/**
 * Shell-quote a value for single-quoted bash.
 *
 * Everything interpolated below is either a Polaris-issued token or operator
 * prose, and the prose is the reason this exists: an apostrophe in "don't break
 * the exporter" would otherwise end the quoting and turn the rest of a sentence
 * into commands.
 */
function quote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The pre-push hook for a run, or null when the gate is off.
 *
 * Push, PR and CI are always skipped in the full gate: the runtime owns the push
 * and the pull request, and a gate that opened its own would leave two.
 */
export function gateScript(input: GateScriptInput): string | null {
    if (input.mode === "off") return null;

    const endpoint = quote(`${input.apiUrl}/api/agents/runs/${input.runId}/gate`);
    const auth = quote(`authorization: Bearer ${input.runToken}`);
    const enigma = `npx -y enigma-cli@${ENIGMA_VERSION}`;

    const lines = [
        "set -uo pipefail",
        'echo "-- Enigma quality gate"',
        "",
        // A step's output as a JSON string. jq is not on every runner, so its
        // absence drops the detail rather than the report.
        "gate_detail() {",
        '  if command -v jq >/dev/null 2>&1; then printf %s "$1" | tail -c 4000 | jq -Rs .; else printf \'""\'; fi',
        "}",
        "",
        // Reporting a step must never be the thing that fails a gate: the verdict
        // is the command's exit code, not whether Polaris was reachable.
        "gate_report() {",
        '  body=$(printf \'{"step":"%s","state":"%s","detail":%s}\' "$1" "$2" "$(gate_detail "${3-}")")',
        `  curl -fsS -m 10 -X POST ${endpoint} \\`,
        `    -H ${auth} -H "content-type: application/json" \\`,
        '    --data-raw "$body" >/dev/null 2>&1 || true',
        "}",
        "",
        // One step: announce it, run it, report what happened. A failure is
        // reported before it propagates, so the screen names the step that
        // stopped the push rather than only saying something did.
        "gate_step() {",
        '  name="$1"; shift',
        '  gate_report "$name" running',
        '  if out=$("$@" 2>&1); then',
        '    gate_report "$name" passed "$out"',
        "  else",
        "    code=$?",
        '    gate_report "$name" failed "$out"',
        '    printf "%s\\n" "$out"',
        '    echo "The Enigma quality gate stopped at $name. Fix what it reported above, commit the fix, and push again."',
        "    exit $code",
        "  fi",
        "}",
        "",
        `gate_step verify ${enigma} verify`
    ];

    if (input.mode === "full") {
        // Initialising is a setup step, not a gate finding: a repository nobody
        // has gated before must not fail its first push over it.
        lines.push(`${enigma} gate init >/dev/null 2>&1 || true`);
        lines.push(
            `gate_step review ${enigma} gate axi run --intent ${quote(input.intent)} --yes --skip push,pr,ci`
        );
    }

    lines.push('echo "-- gate passed"');
    return lines.join("\n");
}
