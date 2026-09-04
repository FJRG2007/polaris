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
import { ChevronDown, KeyRound, ShieldCheck, ShieldAlert } from "lucide-react";

const POLICIES: { value: TelemetryReporters; label: string; hint: string; }[] = [
    {
        value: "internal",
        label: "This network, and anything listed",
        hint: "Where an application deployed by Polaris reports from. Reports arriving from the open internet are turned away."
    },
    {
        value: "listed",
        label: "Only the addresses listed",
        hint: "For a reporter that lives somewhere known - one server, one build runner."
    },
    {
        value: "anywhere",
        label: "Anywhere",
        hint: "What a browser client needs, because its reports come from the addresses of the people using it. The client rules and the key still apply."
    }
];

/** What each refusal reason means to somebody who did not write the rule. */
const REASONS: Record<string, string> = {
    address: "the address is not one this project accepts",
    client: "the client does not match the rules",
    secret: "the key was missing or wrong"
};

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
    const chosen = POLICIES.find((policy) => policy.value === draft.reporters);
    /** The one-line reading of the rules, built once so the clipped element can
     *  carry the whole of it. */
    const summary = [
        chosen?.label,
        draft.allowedCidrs.length > 0 ? `${draft.allowedCidrs.length} listed` : null,
        draft.requireSecret ? "key required" : null
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
                <span className="text-xs font-medium">Who may report</span>
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
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground">
                    <span className="min-w-0 flex-1">
                        {project.refused.count === 1
                            ? "One report was turned away"
                            : `${project.refused.count} reports were turned away`}
                        {project.refused.ip && ` - the last from ${project.refused.ip}`}
                        {project.refused.agent && ` (${project.refused.agent.slice(0, 60)})`}
                        {project.refused.reason && `, because ${REASONS[project.refused.reason]}`}
                        {project.refused.at && (
                            <>
                                {" "}
                                <RelativeTime iso={project.refused.at} />
                            </>
                        )}
                    </span>
                    {project.refused.ip && project.refused.reason === "address" && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={admitRefused}>
                            Allow {project.refused.ip}
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
                        Dismiss
                    </Button>
                </div>
            )}

            {open && (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Reports are accepted from</span>
                        <Select
                            value={draft.reporters}
                            onValueChange={(value) =>
                                setDraft({ ...draft, reporters: value as TelemetryReporters })
                            }
                            className="w-full max-w-md"
                            options={POLICIES.map((policy) => ({
                                value: policy.value,
                                label: policy.label
                            }))}
                        />
                        {chosen && <p className="text-xs text-muted-foreground">{chosen.hint}</p>}
                    </div>

                    {draft.reporters !== "anywhere" && (
                        <RuleListInput
                            label="Addresses and ranges"
                            placeholder="203.0.113.7 or 10.0.0.0/8"
                            hint={
                                draft.reporters === "listed"
                                    ? "Only these may report. Name at least one."
                                    : "Accepted on top of this network."
                            }
                            values={draft.allowedCidrs}
                            validate={(value) => {
                                const parsed = ipRuleField.safeParse(value);
                                return parsed.success
                                    ? { value: parsed.data }
                                    : { error: parsed.error.issues[0]?.message ?? "Invalid rule" };
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
                            Save
                        </Button>
                        {dirty && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setDraft(draftOf(project))}
                            >
                                Discard
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
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2.5">
            <div className="flex items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-xs font-medium">Also require a key</span>
                <Switch
                    checked={project.rules.requireSecret}
                    disabled={busy}
                    aria-label="Also require a key"
                    onChange={(checked) => void (checked ? onMint() : onClear())}
                />
            </div>
            <p className="text-xs text-muted-foreground">
                A second value the reporter has to send, as an <code>X-Polaris-Key</code> header or an
                ordinary bearer token. A Sentry client that lets you set transport headers can carry
                it; one that does not cannot, which is why this is off unless you turn it on.
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
                    <CopyButton value={issued} label="Copy the key" />
                </div>
            ) : project.rules.hasSecret ? (
                <p className="text-xs text-muted-foreground">
                    A key ending {project.rules.secretTail} is in use. It is stored as a digest and
                    cannot be shown again - turn this off and on to make another.
                </p>
            ) : null}
        </div>
    );
}
