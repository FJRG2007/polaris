/**
 * What a run is told about the repository it is about to work in.
 *
 * This is the contract between the control plane and the vendored runtime: the
 * runtime asks for it once at startup and everything it then does - which model,
 * how hard it thinks, whether it may push, whether it may run a shell, what the
 * operator told it - comes from here. The runtime treats an unreachable control
 * plane as "use the defaults", so anything this refuses to say is a permission
 * the run silently gains rather than loses. That is why the refusals below are
 * explicit status codes rather than an empty body.
 *
 * The shape is the runtime's, not ours. Fields Polaris has no equivalent for are
 * sent as the values that mean "not applicable" rather than omitted, because the
 * runtime merges what it gets over its own defaults and an omission would leave
 * the default in place.
 */

import { runSecretsFor } from "@/lib/agents/model-keys";
import { EFFORT_ALIASES } from "@polaris/agent-runtime/shared";
import { ENIGMA_VERSION, gateScript } from "@/lib/agents/agent-gate";
import {
    AGENT_RUN_MODES,
    parseAgentTriggers,
    type AgentGateMode,
    type AgentTrigger,
    type LinkedRepoAccess
} from "@polaris/core";

/** One rule, as the runtime reads it. */
interface RunContextMode {
    id: string;
    name: string;
    description: string;
    prompt: string;
}

export interface RunContextPayload {
    settings: {
        model: string | null;
        effort: number | null;
        modes: RunContextMode[];
        setupScript: string | null;
        postCheckoutScript: string | null;
        prepushScript: string | null;
        stopScript: string | null;
        /** What Enigma the run installs into the agent's home, or null when the
         *  operator turned it off. A Polaris field: the vendored runtime gained
         *  it here rather than upstream. */
        enigma: { version: string } | null;
        push: string;
        shell: string;
        prApproveEnabled: boolean;
        autoMergeEnabled: boolean;
        signedCommits: boolean;
        repoIntelligence: boolean;
        progressComments: boolean;
        statusChecks: boolean;
        approvalCheck: boolean;
        modeInstructions: Record<string, string>;
        learnings: string | null;
        learningsHeadings: never[];
        envAllowlist: string | null;
        xrepoBrief: string | null;
        xrepoLearnings: string | null;
        xrepoLearningsHeadings: never[];
        /** The repositories linked to this one, as read access. A Polaris
         *  field the vendored runtime gained; null keeps the run single-repo. */
        xrepo: LinkedRepoAccess | null;
    };
    apiToken: string;
    /** Always false. The upstream shape carries a funded-model programme Polaris
     *  has no equivalent for, and claiming it would change which models the run
     *  believes it may use. */
    oss: boolean;
    /** Always "payg". The field gates card-related copy upstream; Polaris bills
     *  nobody, so the value that means "nothing is withheld for payment" is the
     *  honest one. */
    plan: "payg";
    dbSecrets?: Record<string, string>;
    /** True when the credential store could not be read at all, which the runtime
     *  reports differently from an operator who has stored none. Without the
     *  distinction a transient failure reads as "you have no API key". */
    secretsUnavailable?: boolean;
}

export interface BuildRunContextInput {
    /** Whose repository this is, and therefore whose provider keys the run
     *  spends. Their own come first; the deployment's are the fallback, and only
     *  where an administrator allows it. */
    ownerId: string;
    /** The run this context is for. Its token is what the runtime authenticates
     *  every later call with. */
    runToken: string;
    model: string;
    /** One of AGENT_EFFORTS. Landed on a position here, which is what the runtime
     *  maps onto the running model's own published ladder. */
    effort: string;
    push: string;
    shell: string;
    /** Operator prose for the automation that started this run, folded into the
     *  prompt by the runtime. Never text from an issue or a comment. */
    instructions: string;
    /** Which mode the automation forces, if it forces one. */
    mode: string | null;
    /** What the quality gate does once the agent has committed. */
    gate: AgentGateMode;
    /** The run the gate reports its steps against. */
    runId: string;
    /** Where those reports go. Stripped of a trailing slash. */
    apiUrl: string;
    /** What this run set out to accomplish, which is what the gate's review pass
     *  uses to tell a deliberate choice from a mistake. Operator prose and the
     *  automation's instructions, never text from an issue or a comment. */
    intent: string;
    /** What the operator's review settings ask a review to contain, for Review
     *  mode (incremental reviews inherit it). Empty adds nothing. */
    reviewGuide?: string;
    /** Standing guidance for every mode: recipes, guideline files, web search. */
    recipes?: string;
    /** What earlier runs noted about the repository. The runtime hands it to the
     *  agent as an editable file and writes it back, so nothing else may ride in
     *  it - whatever did would be saved as a note and doubled on the next run. */
    learnings?: string | null;
    xrepo?: LinkedRepoAccess | null;
}

/** The runtime looks a child mode's operator text up under its parent. */
const PARENT_MODE: Record<string, string> = { IncrementalReview: "Review", Fix: "Build" };
/** The modes that carry their own text, so standing guidance reaches every mode. */
const TOP_MODES = AGENT_RUN_MODES.filter((mode) => !(mode in PARENT_MODE));

/**
 * Build the context for a run.
 *
 * `modes` is left empty: the runtime ships its own catalogue (Build, Review and
 * the rest) and this field is for adding custom ones, which Polaris does not yet
 * offer. `modeInstructions` is how every piece of operator prose reaches the
 * agent; `learnings` is only the agent's own notes, because the runtime writes
 * that field back.
 */
export async function buildRunContext(input: BuildRunContextInput): Promise<RunContextPayload> {
    // Resolved for whoever owns the repository, not for the deployment: their own
    // provider keys come first and the instance's are the fallback, so a run
    // spends the money of the person whose repository it is.
    const secrets = await runSecretsFor(input.ownerId);
    const instructions = input.instructions.trim();
    const join = (...parts: Array<string | undefined>) =>
        parts.map((part) => part?.trim() ?? "").filter(Boolean).join("\n\n");
    // The automation's words go to the mode it forces, or to every mode when it
    // forces none; standing guidance goes to every mode; the review settings
    // only to Review, which IncrementalReview reads as well.
    const forced = input.mode ? (PARENT_MODE[input.mode] ?? input.mode) : null;
    const modeInstructions: Record<string, string> = {};
    for (const mode of TOP_MODES) {
        const text = join(
            forced === null || forced === mode ? instructions : undefined,
            mode === "Review" ? input.reviewGuide : undefined,
            input.recipes
        );
        if (text) modeInstructions[mode] = text;
    }

    return {
        settings: {
            model: input.model,
            effort: EFFORT_ALIASES[input.effort] ?? EFFORT_ALIASES.medium ?? null,
            modes: [],
            setupScript: null,
            postCheckoutScript: null,
            // The gate runs here rather than as a stop hook: at this point the
            // agent's work is committed and nothing has left the machine, so a
            // refusal is still cheap and the agent is still there to act on it.
            prepushScript: gateScript({
                mode: input.gate,
                apiUrl: input.apiUrl,
                runId: input.runId,
                runToken: input.runToken,
                intent: input.intent
            }),
            stopScript: null,
            enigma: { version: ENIGMA_VERSION },
            push: input.push,
            shell: input.shell,
            // Approving and auto-merging its own work is not something an agent
            // should be able to do on a repository Polaris configured for somebody.
            prApproveEnabled: false,
            autoMergeEnabled: false,
            // Commits are signed by GitHub only when made through the API, which
            // needs a token Polaris does not mint for the runtime.
            signedCommits: false,
            repoIntelligence: false,
            progressComments: true,
            statusChecks: true,
            // A merge gate must never turn itself on.
            approvalCheck: false,
            modeInstructions,
            learnings: input.learnings?.trim() || null,
            learningsHeadings: [],
            envAllowlist: null,
            xrepoBrief: null,
            xrepoLearnings: null,
            xrepoLearningsHeadings: [],
            xrepo: input.xrepo ?? null
        },
        apiToken: input.runToken,
        oss: false,
        plan: "payg",
        ...(secrets === null ? { secretsUnavailable: true } : { dbSecrets: secrets })
    };
}

/** Which triggers a repository's automations cover, for the screens that show it. */
export function triggersFrom(automations: Array<{ trigger: string }>): AgentTrigger[] {
    return parseAgentTriggers(JSON.stringify(automations.map((row) => row.trigger)));
}
