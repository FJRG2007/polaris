"use client";

/**
 * Ceilings on how much agent work something may do.
 *
 * Every rule that applies to a run has to be satisfied, so the most restrictive
 * one wins and there is no precedence to explain or get wrong. A rule on a role
 * or a group applies to each member rather than to a pot they share, which the
 * copy says out loud - the alternative reading is one somebody would otherwise
 * discover the first time a colleague's Monday stopped their Tuesday.
 */

import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import { deleteUsageLimitAction, saveUsageLimitAction } from "./actions";
import type { UsageLimitView } from "@/lib/agents/agent-usage-limits";
import {
    LIMIT_METRICS,
    LIMIT_PERIODS,
    LIMIT_PERIOD_LABELS,
    LIMIT_PERIOD_PER,
    LIMIT_SUBJECTS,
    type LimitMetric,
    type LimitPeriod,
    type LimitSubject
} from "@polaris/core";

/** What each kind of subject is called, and what its id looks like, so the field
 *  can say what to type instead of leaving somebody to guess. */
const SUBJECTS: Record<LimitSubject, { label: string; placeholder: string; note: string }> = {
    everyone: { label: "Everyone", placeholder: "", note: "Applies to every account, each counted on its own." },
    user: { label: "One person", placeholder: "account id", note: "" },
    role: { label: "A role", placeholder: "role id", note: "Each member of the role gets this much." },
    group: { label: "A group", placeholder: "group id", note: "Each member of the group gets this much." },
    repo: { label: "One repository", placeholder: "owner/name", note: "" },
    org: { label: "A GitHub account", placeholder: "login", note: "Every repository under it, counted together." }
};

const METRICS: Record<LimitMetric, string> = { runs: "runs", tokens: "tokens" };

export function UsageLimitsCard({ limits }: { limits: UsageLimitView[] }) {
    const [rows, setRows] = useState(limits);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const remove = (id: string) => {
        setError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => deleteUsageLimitAction({ id }), setError);
                if (result && !result.error) setRows((was) => was.filter((row) => row.id !== id));
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">Usage limits</p>
                        <p className="text-muted-foreground text-xs">
                            A run that would cross any limit that applies to it is refused before it starts, with the
                            reason. Nothing is limited until you add one.
                        </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
                        <Plus className="size-4 shrink-0" />
                        Add
                    </Button>
                </div>

                {rows.map((row) => (
                    <div
                        key={row.id}
                        className="border-border/60 flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                    >
                        <span className="min-w-0 flex-1 truncate">
                            {SUBJECTS[row.subjectType].label}
                            {row.subjectId ? ` - ${row.subjectId}` : ""}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                            {row.amount} {METRICS[row.metric]} / {LIMIT_PERIOD_LABELS[row.period]}
                        </span>
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            onClick={() => remove(row.id)}
                            aria-label="Remove this limit"
                            title="Remove"
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    </div>
                ))}

                {adding ? (
                    <AddLimit
                        onCancel={() => setAdding(false)}
                        onSaved={(row) => {
                            setAdding(false);
                            // The same subject, metric and period is one rule, so a
                            // repeat replaces rather than piles up - which is what
                            // the store does too.
                            setRows((was) => [
                                ...was.filter(
                                    (entry) =>
                                        !(
                                            entry.subjectType === row.subjectType &&
                                            entry.subjectId === row.subjectId &&
                                            entry.metric === row.metric &&
                                            entry.period === row.period
                                        )
                                ),
                                row
                            ]);
                        }}
                        onError={setError}
                    />
                ) : null}

                {error ? <p className="text-xs text-red-400">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

function AddLimit({
    onCancel,
    onSaved,
    onError
}: {
    onCancel: () => void;
    onSaved: (row: UsageLimitView) => void;
    onError: (message: string | null) => void;
}) {
    const [subjectType, setSubjectType] = useState<LimitSubject>("everyone");
    const [subjectId, setSubjectId] = useState("");
    const [metric, setMetric] = useState<LimitMetric>("runs");
    const [period, setPeriod] = useState<LimitPeriod>("day");
    const [amount, setAmount] = useState("50");
    const [pending, startTransition] = useTransition();

    const save = () => {
        onError(null);
        const row = {
            subjectType,
            subjectId: subjectType === "everyone" ? "" : subjectId.trim(),
            metric,
            period,
            amount: Number(amount)
        };
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => saveUsageLimitAction(row), onError);
                // The id is the store's; nothing on screen reads it until the page
                // is next loaded, so a placeholder that cannot collide will do.
                if (result && !result.error) onSaved({ ...row, id: `${Date.now()}` });
            })();
        });
    };

    return (
        <div className="border-border/60 space-y-2 rounded-md border p-2">
            <div className="grid gap-2 sm:grid-cols-2">
                <Select
                    value={subjectType}
                    onValueChange={(next) => setSubjectType(next as LimitSubject)}
                    options={LIMIT_SUBJECTS.map((slug) => ({ value: slug, label: SUBJECTS[slug].label }))}
                />
                {subjectType === "everyone" ? null : (
                    <Input
                        value={subjectId}
                        placeholder={SUBJECTS[subjectType].placeholder}
                        onChange={(event) => setSubjectId(event.target.value)}
                    />
                )}
                <Input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="50" />
                <Select
                    value={metric}
                    onValueChange={(next) => setMetric(next as LimitMetric)}
                    options={LIMIT_METRICS.map((slug) => ({ value: slug, label: METRICS[slug] }))}
                />
                <Select
                    value={period}
                    onValueChange={(next) => setPeriod(next as LimitPeriod)}
                    options={LIMIT_PERIODS.map((slug) => ({ value: slug, label: LIMIT_PERIOD_PER[slug] }))}
                />
            </div>

            {SUBJECTS[subjectType].note ? (
                <p className="text-muted-foreground text-xs">{SUBJECTS[subjectType].note}</p>
            ) : null}

            <div className="flex items-center gap-2">
                <Button size="sm" onClick={save} disabled={pending}>
                    Save
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
