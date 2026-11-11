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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";
import {
    AGENT_GATE_MODES,
    DEFAULT_AGENT_POLICY,
    type AgentGateMode,
    type AgentPolicy
} from "@polaris/core";

/** What a Select stores for "do not decide this here". Not a valid value of any
 *  of the settings, so it can never be mistaken for one. */
const INHERIT = "__inherit__";


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
    const t = useTranslations("agents");
    const resolved = policy ?? DEFAULT_AGENT_POLICY;
    const yesNo = (value: boolean) => (value ? t("settingsFields.on") : t("settingsFields.off"));

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <label className="text-sm font-medium">{t("settingsFields.pullRequests")}</label>
                <Select
                    value={pullRequests === null ? INHERIT : String(pullRequests)}
                    onValueChange={(next) => onPullRequests(next === INHERIT ? null : next === "true")}
                    options={[
                        { value: INHERIT, label: t("settingsFields.inherit", { value: yesNo(resolved.pullRequests) }) },
                        { value: "true", label: t("settingsFields.on") },
                        { value: "false", label: t("settingsFields.off") }
                    ]}
                />
                <p className="text-xs text-muted-foreground">{t("settingsFields.pullRequestsHint")}</p>
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">{t("settingsFields.issues")}</label>
                <Select
                    value={issues === null ? INHERIT : String(issues)}
                    onValueChange={(next) => onIssues(next === INHERIT ? null : next === "true")}
                    options={[
                        { value: INHERIT, label: t("settingsFields.inherit", { value: yesNo(resolved.issues) }) },
                        { value: "true", label: t("settingsFields.on") },
                        { value: "false", label: t("settingsFields.off") }
                    ]}
                />
            </div>

            <div className="space-y-1">
                <label className="text-sm font-medium">{t("settingsFields.gate")}</label>
                <Select
                    value={gate ?? INHERIT}
                    onValueChange={(next) => onGate(next === INHERIT ? null : (next as AgentGateMode))}
                    options={[
                        {
                            value: INHERIT,
                            label: t("settingsFields.inherit", { value: agentWord(t, "gateMode", resolved.gate) })
                        },
                        ...AGENT_GATE_MODES.map((value) => ({ value, label: agentWord(t, "gateMode", value) }))
                    ]}
                />
                <p className="text-xs text-muted-foreground">{agentWord(t, "gateModeNote", gate ?? resolved.gate)}</p>
            </div>
        </div>
    );
}
