"use client";

import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { addDefaultAutomationsAction, removeAutomationAction, saveAutomationAction } from "../actions";
import { AGENT_TRIGGERS, AGENT_TRIGGER_LABELS, AGENT_TRIGGER_NOTES, type AgentTrigger } from "@polaris/core";
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
            Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
        return { labels: list(parsed.labels), branches: list(parsed.branches), authors: list(parsed.authors) };
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
                    Add a repository first. Rules are per repository.
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
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" />
                    Add a rule
                </Button>
            </div>

            <Card>
                <CardBody className="p-0">
                    {rules.length === 0 ? (
                        <div className="space-y-3 px-4 py-10">
                            <p className="text-sm text-muted-foreground">
                                No rules yet, so these repositories only answer when the app is mentioned. A rule is
                                what makes one act on its own - reply to a new issue, review a new pull request.
                            </p>
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
                                        Add the usual rules to {repo.name}
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
                                                {AGENT_TRIGGER_LABELS[rule.trigger as AgentTrigger] ?? rule.trigger}
                                                <span className="ml-2 text-xs text-muted-foreground">
                                                    {repo?.name ?? "unknown repository"}
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
                                        {!rule.enabled ? <Badge variant="neutral">Off</Badge> : null}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label="Remove this rule"
                                            title="Remove this rule"
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
    const existing = rule ? parseCondition(rule.condition) : { labels: [], branches: [], authors: [] };
    const [repoId, setRepoId] = useState(rule?.repoId ?? repos[0]?.id ?? "");
    const [trigger, setTrigger] = useState<AgentTrigger>((rule?.trigger as AgentTrigger) ?? "pr.opened");
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
                                condition: { labels: list(labels), branches: list(branches), authors: [] },
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
                    <DialogTitle>{rule ? "Edit rule" : "Add a rule"}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">Repository</label>
                        <Select
                            value={repoId}
                            onValueChange={setRepoId}
                            options={repos.map((repo) => ({ value: repo.id, label: repo.name }))}
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">When</label>
                        <Select
                            value={trigger}
                            onValueChange={(next) => setTrigger(next as AgentTrigger)}
                            options={AGENT_TRIGGERS.filter((value) => value !== "manual" && value !== "mention").map(
                                (value) => ({ value, label: AGENT_TRIGGER_LABELS[value] })
                            )}
                        />
                        <p className="text-xs text-muted-foreground">{AGENT_TRIGGER_NOTES[trigger]}</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Only these labels</label>
                        <Input
                            value={labels}
                            onChange={(event) => setLabels(event.target.value)}
                            placeholder="bug, needs-triage"
                        />
                        <p className="text-xs text-muted-foreground">Comma separated. Leave empty for any label.</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Only these base branches</label>
                        <Input
                            value={branches}
                            onChange={(event) => setBranches(event.target.value)}
                            placeholder="main"
                        />
                        <p className="text-xs text-muted-foreground">Comma separated. Leave empty for any branch.</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Instructions</label>
                        <Textarea
                            rows={4}
                            value={instructions}
                            onChange={(event) => setInstructions(event.target.value)}
                            placeholder="Review for correctness and security. Do not comment on formatting."
                        />
                        <p className="text-xs text-muted-foreground">
                            Given to the agent alongside what triggered the run. Yours, not the issue author&apos;s.
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Rule is on" />
                        <span className="text-sm">On</span>
                    </div>

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={!repoId || pending}>
                        {pending ? "Saving..." : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
