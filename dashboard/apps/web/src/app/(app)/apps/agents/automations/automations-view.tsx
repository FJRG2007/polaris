"use client";

import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import {
    addDefaultAutomationsAction,
    removeAutomationAction,
    saveAutomationAction
} from "../actions";
import { AGENT_TRIGGERS, type AgentTrigger } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";

interface Rule {
    id: string;
    repoId: string;
    trigger: string;
    condition: string;
    mode: string | null;
    instructions: string;
    enabled: boolean;
}

/** A rule's narrowing, read back off the row. Anything malformed does not narrow,
 *  which is what an empty form means. */
function parseCondition(raw: string): { labels: string[]; branches: string[]; authors: string[] } {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const list = (value: unknown) =>
            Array.isArray(value)
                ? value.filter((entry): entry is string => typeof entry === "string")
                : [];
        return {
            labels: list(parsed.labels),
            branches: list(parsed.branches),
            authors: list(parsed.authors)
        };
    } catch {
        return { labels: [], branches: [], authors: [] };
    }
}

export function AutomationsView({
    repos,
    rules
}: {
    repos: Array<{ id: string; name: string }>;
    rules: Rule[];
}) {
    const t = useTranslations("agents");
    const [editing, setEditing] = useState<Rule | null>(null);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const addDefaults = (repoId: string) => {
        startTransition(() => {
            void runAction(() => addDefaultAutomationsAction({ repoId }), setError);
        });
    };

    if (repos.length === 0) {
        return (
            <Card>
                <CardBody className="py-10 text-sm text-muted-foreground">
                    {t("rules.noRepos")}
                </CardBody>
            </Card>
        );
    }

    const remove = (rule: Rule) => {
        startTransition(() => {
            void runAction(() => removeAutomationAction({ id: rule.id }), setError);
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" />
                    {t("rules.add")}
                </Button>
            </div>

            <Card>
                <CardBody className="p-0">
                    {rules.length === 0 ? (
                        <div className="space-y-3 px-4 py-10">
                            <p className="text-sm text-muted-foreground">{t("rules.none")}</p>
                            {/* Repositories added from now on get these already. This is
                                for the ones added before, and for anybody who cleared
                                them and wants them back. */}
                            <div className="flex flex-wrap gap-2">
                                {repos.map((repo) => (
                                    <Button
                                        key={repo.id}
                                        variant="secondary"
                                        size="sm"
                                        disabled={pending}
                                        onClick={() => addDefaults(repo.id)}
                                    >
                                        {t("rules.addUsual", { name: repo.name })}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <ul className="divide-y divide-white/5">
                            {rules.map((rule) => {
                                const condition = parseCondition(rule.condition);
                                const repo = repos.find((entry) => entry.id === rule.repoId);
                                return (
                                    <li key={rule.id} className="flex items-start gap-3 px-4 py-3">
                                        <button
                                            type="button"
                                            onClick={() => setEditing(rule)}
                                            className="min-w-0 flex-1 text-left"
                                        >
                                            <p className="truncate text-sm">
                                                {agentWord(t, "trigger", rule.trigger)}
                                                <span className="ml-2 text-xs text-muted-foreground">
                                                    {repo?.name ?? t("rules.unknownRepo")}
                                                </span>
                                            </p>
                                            {condition.labels.length > 0 ? (
                                                <p className="mt-1 flex flex-wrap gap-1">
                                                    {condition.labels.map((label) => (
                                                        <Badge key={label} variant="neutral">
                                                            {label}
                                                        </Badge>
                                                    ))}
                                                </p>
                                            ) : null}
                                            {rule.instructions ? (
                                                <p className="mt-1 truncate text-xs text-muted-foreground">
                                                    {rule.instructions}
                                                </p>
                                            ) : null}
                                        </button>
                                        {!rule.enabled ? (
                                            <Badge variant="neutral">{t("overview.off")}</Badge>
                                        ) : null}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t("rules.remove")}
                                            title={t("rules.remove")}
                                            onClick={() => remove(rule)}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>

            {adding || editing ? (
                <RuleDialog
                    repos={repos}
                    rule={editing}
                    onClose={() => {
                        setAdding(false);
                        setEditing(null);
                    }}
                />
            ) : null}
        </div>
    );
}

function RuleDialog({
    repos,
    rule,
    onClose
}: {
    repos: Array<{ id: string; name: string }>;
    rule: Rule | null;
    onClose: () => void;
}) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const existing = rule
        ? parseCondition(rule.condition)
        : { labels: [], branches: [], authors: [] };
    const [repoId, setRepoId] = useState(rule?.repoId ?? repos[0]?.id ?? "");
    const [trigger, setTrigger] = useState<AgentTrigger>(
        (rule?.trigger as AgentTrigger) ?? "pr.opened"
    );
    const [labels, setLabels] = useState(existing.labels.join(", "));
    const [branches, setBranches] = useState(existing.branches.join(", "));
    const [instructions, setInstructions] = useState(rule?.instructions ?? "");
    const [enabled, setEnabled] = useState(rule?.enabled ?? true);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const list = (value: string) =>
        value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);

    const save = () => {
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        saveAutomationAction({
                            ...(rule ? { id: rule.id } : {}),
                            repoId,
                            automation: {
                                trigger,
                                condition: {
                                    labels: list(labels),
                                    branches: list(branches),
                                    authors: []
                                },
                                mode: null,
                                instructions,
                                enabled
                            }
                        }),
                    setError
                );
                if (result && !result.error) onClose();
                else if (result?.error) setError(result.error);
            })();
        });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{rule ? t("rules.edit") : t("rules.add")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("sessions.form.repository")}</label>
                        <Select
                            value={repoId}
                            onValueChange={setRepoId}
                            options={repos.map((repo) => ({ value: repo.id, label: repo.name }))}
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("rules.when")}</label>
                        <Select
                            value={trigger}
                            onValueChange={(next) => setTrigger(next as AgentTrigger)}
                            options={AGENT_TRIGGERS.filter(
                                (value) => value !== "manual" && value !== "mention"
                            ).map((value) => ({ value, label: agentWord(t, "trigger", value) }))}
                        />
                        <p className="text-xs text-muted-foreground">{agentWord(t, "triggerNote", trigger)}</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("rules.labels")}</label>
                        <Input
                            value={labels}
                            onChange={(event) => setLabels(event.target.value)}
                            placeholder="bug, needs-triage" // i18n-ignore example label names
                        />
                        <p className="text-xs text-muted-foreground">{t("rules.labelsHint")}</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("rules.branches")}</label>
                        <Input
                            value={branches}
                            onChange={(event) => setBranches(event.target.value)}
                            placeholder="main" // i18n-ignore a branch name
                        />
                        <p className="text-xs text-muted-foreground">{t("rules.branchesHint")}</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("rules.instructions")}</label>
                        <Textarea
                            rows={4}
                            value={instructions}
                            onChange={(event) => setInstructions(event.target.value)}
                            placeholder={t("rules.instructionsPlaceholder")}
                        />
                        <p className="text-xs text-muted-foreground">{t("rules.instructionsHint")}</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <Switch checked={enabled} onChange={setEnabled} aria-label={t("rules.isOn")} />
                        <span className="text-sm">{t("rules.on")}</span>
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={save} disabled={!repoId || pending}>
                        {pending ? t("rules.saving") : t("rules.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
