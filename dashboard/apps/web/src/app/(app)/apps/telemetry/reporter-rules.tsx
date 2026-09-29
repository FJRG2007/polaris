"use client";

/**
 * Who may report into a project.
 *
 * The key in a DSN names a project and proves nothing: it ships inside the
 * browser bundle of every web application that reports from one, it turns up in
 * build logs, and anybody who has seen it can write into that project until it is
 * rotated. That is how the protocol works, so this is the screen that narrows who
 * gets to try - where from, with what, and optionally carrying a key of its own.
 *
 * A new project starts on "the machines on this network", which is where an
 * application deployed by Polaris reports from and therefore costs nothing to set
 * up. The reason that is a safe default rather than a trap is the line at the top
 * of this panel: what gets turned away is counted, and shown here with the
 * address it came from and a button to admit it. A project that refuses
 * everything says so instead of looking healthy.
 *
 * The editors are the ones the API keys screen uses, because these are the same
 * two questions asked of a different credential and a second set of them would
 * drift.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { CopyButton } from "@/components/copy-button";
import { Button, Select, Switch, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { RuleListInput } from "@/components/rule-list-input";
import { ClientRulesEditor } from "@/components/client-rules-editor";
import { ipRuleField, type TelemetryReporters } from "@polaris/core";
import type { ProjectSummary } from "@/lib/telemetry/project-service";
/** What each refusal reason means to somebody who did not write the rule. */
import { ChevronDown, KeyRound, ShieldCheck, ShieldAlert } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

/** Each policy, said as `rules.policies.<value>.label` and `.hint`. */
const POLICIES: readonly TelemetryReporters[] = ["internal", "listed", "anywhere"];

/** Why a report was turned away, said as `rules.reasons.<reason>`. */
const REASONS = new Set(["address", "client", "secret"]);

/** The one sentence the shared IP rule refuses with, as core writes it. */
const IP_RULE_MESSAGE = "Must be an IP address or CIDR range";

type Draft = {
    reporters: TelemetryReporters;
    allowedCidrs: string[];
    allowedUserAgents: string[];
    deniedUserAgents: string[];
    requireSecret: boolean;
};

function draftOf(project: ProjectSummary): Draft {
    return {
        reporters: project.rules.reporters,
        allowedCidrs: [...project.rules.allowedCidrs],
        allowedUserAgents: [...project.rules.allowedUserAgents],
        deniedUserAgents: [...project.rules.deniedUserAgents],
        requireSecret: project.rules.requireSecret
    };
}

function same(a: Draft, b: Draft): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function ReporterRules({
    project,
    onDone
}: {
    project: ProjectSummary;
    onDone: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    const tc = useTranslations("components");
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(() => draftOf(project));
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    /** The key, for the moment it exists. There is nowhere to read it back from. */
    const [issued, setIssued] = useState<string | null>(null);

    useEffect(() => {
        setDraft(draftOf(project));
        setIssued(null);
    }, [project]);

    const dirty = !same(draft, draftOf(project));
    const chosen = POLICIES.includes(draft.reporters) ? draft.reporters : null;
    const policyWord = (policy: TelemetryReporters, part: "label" | "hint") =>
        t(`rules.policies.${policy}.${part}` as NamespaceKey<"telemetry">);
    /** The one-line reading of the rules, built once so the clipped element can
     *  carry the whole of it. */
    const summary = [
        chosen ? policyWord(chosen, "label") : null,
        draft.allowedCidrs.length > 0 ? t("rules.listed", { count: draft.allowedCidrs.length }) : null,
        draft.requireSecret ? t("rules.keyRequired") : null
    ]
        .filter(Boolean)
        .join(" - ");

    async function save(next: Draft) {
        setBusy(true);
        const result = await runAction(
            () => actions.setReporterRulesAction(project.id, next),
            setError
        );
        setBusy(false);
        if (!result?.error) {
            setError("");
            await onDone();
        }
    }

    /** Admit the address that was just turned away. One click, because the
     *  alternative is copying an address out of a sentence into a field. */
    async function admitRefused() {
        const address = project.refused.ip;
        if (!address) return;
        const next: Draft = {
            ...draft,
            allowedCidrs: draft.allowedCidrs.includes(address)
                ? draft.allowedCidrs
                : [...draft.allowedCidrs, address]
        };
        setDraft(next);
        await save(next);
        await runAction(() => actions.clearTelemetryRefusalsAction(project.id), setError);
        await onDone();
    }

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex items-center gap-2 text-left"
            >
                {draft.reporters === "anywhere" && !draft.requireSecret ? (
                    <ShieldAlert className="size-4 shrink-0 text-warning" />
                ) : (
                    <ShieldCheck className="size-4 shrink-0 text-success" />
                )}
                <span className="text-xs font-medium">{t("rules.whoMayReport")}</span>
                <span
                    className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                    title={summary}
                >
                    {summary}
                </span>
                <ChevronDown
                    className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                />
            </button>

            {project.refused.count > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning-foreground">
                    <span className="min-w-0 flex-1">
                        {t.rich("rules.refused", {
                            count: project.refused.count,
                            hasIp: project.refused.ip ? "yes" : "no",
                            ip: project.refused.ip ?? "",
                            hasAgent: project.refused.agent ? "yes" : "no",
                            agent: project.refused.agent?.slice(0, 60) ?? "",
                            hasReason: project.refused.reason ? "yes" : "no",
                            reason: project.refused.reason
                                ? REASONS.has(project.refused.reason)
                                    ? t(`rules.reasons.${project.refused.reason}` as NamespaceKey<"telemetry">)
                                    : project.refused.reason
                                : "",
                            hasTime: project.refused.at ? "yes" : "no",
                            time: () =>
                                project.refused.at ? <RelativeTime key="time" iso={project.refused.at} /> : null
                        })}
                    </span>
                    {project.refused.ip && project.refused.reason === "address" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={admitRefused}>
                            {t("rules.allow", { ip: project.refused.ip })}
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                            await runAction(
                                () => actions.clearTelemetryRefusalsAction(project.id),
                                setError
                            );
                            await onDone();
                        }}
                    >
                        {t("rules.dismiss")}
                    </Button>
                </div>
            )}

            {open && (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("rules.acceptedFrom")}</span>
                        <Select
                            value={draft.reporters}
                            onValueChange={(value) =>
                                setDraft({ ...draft, reporters: value as TelemetryReporters })
                            }
                            className="w-full max-w-md"
                            options={POLICIES.map((policy) => ({
                                value: policy,
                                label: policyWord(policy, "label")
                            }))}
                        />
                        {chosen && <p className="text-xs text-muted-foreground">{policyWord(chosen, "hint")}</p>}
                    </div>

                    {draft.reporters !== "anywhere" && (
                        <RuleListInput
                            label={t("rules.addresses")}
                            placeholder={tc("accessRules.ipsPlaceholder")}
                            hint={draft.reporters === "listed" ? t("rules.onlyThese") : t("rules.onTop")}
                            values={draft.allowedCidrs}
                            validate={(value) => {
                                const parsed = ipRuleField.safeParse(value);
                                if (parsed.success) return { value: parsed.data };
                                return {
                                    error:
                                        parsed.error.issues[0]?.message === IP_RULE_MESSAGE
                                            ? tc("accessRules.ipInvalid")
                                            : tc("accessRules.invalid")
                                };
                            }}
                            onChange={(allowedCidrs) => setDraft({ ...draft, allowedCidrs })}
                        />
                    )}

                    <ClientRulesEditor
                        value={{
                            allowedUserAgents: draft.allowedUserAgents,
                            deniedUserAgents: draft.deniedUserAgents
                        }}
                        onChange={(clients) => setDraft({ ...draft, ...clients })}
                    />

                    <ProjectKey
                        project={project}
                        issued={issued}
                        busy={busy}
                        onMint={async () => {
                            setBusy(true);
                            const result = await runAction(
                                () => actions.mintTelemetrySecretAction(project.id),
                                setError
                            );
                            setBusy(false);
                            if (result?.secret) {
                                setIssued(result.secret);
                                setDraft({ ...draft, requireSecret: true });
                                await onDone();
                            }
                        }}
                        onClear={async () => {
                            setBusy(true);
                            await runAction(
                                () => actions.clearTelemetrySecretAction(project.id),
                                setError
                            );
                            setBusy(false);
                            setIssued(null);
                            setDraft({ ...draft, requireSecret: false });
                            await onDone();
                        }}
                    />

                    {error && <p className="text-xs text-danger">{error}</p>}

                    <div className="flex items-center gap-2">
                        <Button size="sm" disabled={!dirty || busy} onClick={() => save(draft)}>
                            {t("settings.save")}
                        </Button>
                        {dirty && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setDraft(draftOf(project))}
                            >
                                {t("rules.discard")}
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * The project's own key.
 *
 * Not part of the Sentry protocol - no current client sends a second credential -
 * so this is the option for everything else: a reporter that posts the envelope
 * itself, or a client whose transport can be given a header. It is the only one
 * of the three rules on this screen that a forged packet cannot walk past, which
 * is why it is worth having even though it is off by default.
 *
 * Shown once. What is stored is a digest, so there is no second place to read it
 * from and losing it means making another.
 */
function ProjectKey({
    project,
    issued,
    busy,
    onMint,
    onClear
}: {
    project: ProjectSummary;
    issued: string | null;
    busy: boolean;
    onMint: () => Promise<void>;
    onClear: () => Promise<void>;
}) {
    const t = useTranslations("telemetry");
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2.5">
            <div className="flex items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-xs font-medium">{t("rules.requireKey")}</span>
                <Switch
                    checked={project.rules.requireSecret}
                    disabled={busy}
                    aria-label={t("rules.requireKey")}
                    onChange={(checked) => void (checked ? onMint() : onClear())}
                />
            </div>
            <p className="text-xs text-muted-foreground">
                {t.rich("rules.keyHint", {
                    // i18n-ignore a header name
                    header: () => <code key="header">X-Polaris-Key</code>
                })}
            </p>
            {issued ? (
                <div className="flex items-center gap-2">
                    {/* The one moment this value exists. Clipped to the panel's
                        width, so the element carries it in full - and the copy
                        button beside it is the way it is actually taken. */}
                    <code
                        className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs"
                        title={issued}
                    >
                        {issued}
                    </code>
                    <CopyButton value={issued} label={t("rules.copyKey")} />
                </div>
            ) : project.rules.hasSecret ? (
                <p className="text-xs text-muted-foreground">
                    {t("rules.keyInUse", { tail: project.rules.secretTail ?? "" })}
                </p>
            ) : null}
        </div>
    );
}
