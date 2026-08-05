"use client";

/**
 * The settings a repository can either inherit or answer for itself.
 *
 * Every one of them is also decided above the repository - once for the account
 * and once for the whole instance - so the field that renders them has three
 * answers, not two: yes, no, and "whatever the tier above says". The inherited
 * option names what it currently resolves to, because "Inherit" alone makes
 * somebody open another screen to find out what they just chose.
 */

import { Select } from "@polaris/ui";
import {
    AGENT_GATE_MODES,
    AGENT_GATE_MODE_LABELS,
    AGENT_GATE_MODE_NOTES,
    DEFAULT_AGENT_POLICY,
    type AgentGateMode,
    type AgentPolicy
} from "@polaris/core";

/** What a Select stores for "do not decide this here". Not a valid value of any
 *  of the settings, so it can never be mistaken for one. */
const INHERIT = "__inherit__";

const yesNo = (value: boolean) => (value ? "On" : "Off");

export function RepoSettingsFields({
    policy,
    pullRequests,
    issues,
    gate,
    onPullRequests,
    onIssues,
    onGate
}: {
    /** What the tiers above resolve to right now, so an inherited choice can say
     *  what it means. Null while it is still being read. */
    policy: AgentPolicy | null;
    pullRequests: boolean | null;
    issues: boolean | null;
    gate: AgentGateMode | null;
    onPullRequests: (next: boolean | null) => void;
    onIssues: (next: boolean | null) => void;
    onGate: (next: AgentGateMode | null) => void;
}) {
    const resolved = policy ?? DEFAULT_AGENT_POLICY;

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <label className="text-sm font-medium">Pull requests</label>
                <Select
                    value={pullRequests === null ? INHERIT : String(pullRequests)}
                    onValueChange={(next) => onPullRequests(next === INHERIT ? null : next === "true")}
                    options={[
                        { value: INHERIT, label: `Inherit (${yesNo(resolved.pullRequests)})` },
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" }
                    ]}
                />
                <p className="text-xs text-muted-foreground">
                    Whether a pull request can start a run. Somebody naming the app in a comment still gets an answer
                    either way.
                </p>
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">Issues</label>
                <Select
                    value={issues === null ? INHERIT : String(issues)}
                    onValueChange={(next) => onIssues(next === INHERIT ? null : next === "true")}
                    options={[
                        { value: INHERIT, label: `Inherit (${yesNo(resolved.issues)})` },
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" }
                    ]}
                />
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">Quality gate</label>
                <Select
                    value={gate ?? INHERIT}
                    onValueChange={(next) => onGate(next === INHERIT ? null : (next as AgentGateMode))}
                    options={[
                        { value: INHERIT, label: `Inherit (${AGENT_GATE_MODE_LABELS[resolved.gate]})` },
                        ...AGENT_GATE_MODES.map((value) => ({ value, label: AGENT_GATE_MODE_LABELS[value] }))
                    ]}
                />
                <p className="text-xs text-muted-foreground">{AGENT_GATE_MODE_NOTES[gate ?? resolved.gate]}</p>
            </div>
        </div>
    );
}
