"use client";

/**
 * Orchestration runs: what is waiting on you first, then each run as a graph of
 * its tasks.
 *
 * The needs-you queue is the reason this page exists. A run is many sessions at
 * once, and the only way that is less work than doing it yourself is if the
 * screen says which one wants a decision - a gate to approve, a question to
 * answer, a set of variants to choose between - without opening each.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, GitCompare, Loader2, Plus, Square, X } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Switch,
    Textarea,
    pollWhileVisible
} from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { agentText } from "@/lib/agents/words";
import * as polls from "@/components/agents/sessions/sessions-polls";
import { PagedPicker } from "@/components/paged-picker";
import { repoOptionsAction } from "@/components/agents/sessions/actions";
import type { RepoOption } from "@/lib/agents/repo-options";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { RunsOverview } from "@/lib/agents/orchestration-service";
import { AgentSelect, agentOf } from "@/components/agents/agent-select";
import {
    addTaskAction,
    answerQuestionAction,
    cancelRunAction,
    createRunAction,
    resolveGateAction
} from "./actions";

type Run = RunsOverview["runs"][number];
type Task = Run["tasks"][number];

/** How often an active run is re-read: quick enough that a gate is seen. */
const REFRESH_MS = 5000;

const STATUS_TONE: Record<string, string> = {
    pending: "text-muted-foreground",
    ready: "text-muted-foreground",
    dispatched: "text-violet-400",
    blocked: "text-warning",
    completed: "text-success",
    failed: "text-danger"
};

const STATUSES = ["pending", "ready", "dispatched", "blocked", "completed", "failed"] as const;
const RUN_STATUSES = ["active", "completed", "cancelled"] as const;

export function OrchestrationView({ overview }: { overview: RunsOverview }) {
    const t = useTranslations("agents");
    const router = useRouter();
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const active = overview.runs.some((run) => run.status === "active");
    useEffect(() => {
        if (!active && overview.waiting.length === 0) return;
        return pollWhileVisible(() => router.refresh(), REFRESH_MS);
    }, [active, overview.waiting.length, router]);

    const objectiveOf = (runId: string) =>
        overview.runs.find((run) => run.id === runId)?.objective ?? "";
    const needCount = overview.needs.length + overview.waiting.length;

    return (
        <div className="space-y-6">
            <div className="flex justify-end">
                <Button onClick={() => setCreating(true)}>
                    <Plus className="size-4 shrink-0" />
                    {t("orchestration.newRun")}
                </Button>
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <section className="space-y-2">
                <h2 className="text-sm font-medium">
                    {t("orchestration.needsYou")}
                    {needCount > 0 ? <Badge className="ml-2">{needCount}</Badge> : null}
                </h2>
                {needCount === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("orchestration.nothingNeeded")}</p>
                ) : (
                    <div className="space-y-2">
                        {overview.needs.map((need) => (
                            <NeedRow
                                key={need.kind === "question" ? need.messageId : need.kind === "gate" ? need.taskId : need.groupId}
                                need={need}
                                objective={objectiveOf(need.runId)}
                                onError={setError}
                            />
                        ))}
                        {overview.waiting.map((session) => (
                            <Card key={session.id}>
                                <CardBody className="flex items-center gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm" title={session.title}>
                                            {session.title}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t("orchestration.sessionWaiting")}
                                        </p>
                                    </div>
                                    <Button asChild size="sm" variant="secondary">
                                        <Link href={`/polar?session=${session.id}`}>
                                            {t("orchestration.open")}
                                        </Link>
                                    </Button>
                                </CardBody>
                            </Card>
                        ))}
                    </div>
                )}
            </section>

            <section className="space-y-3">
                <h2 className="text-sm font-medium">{t("orchestration.runs")}</h2>
                {overview.runs.length === 0 ? (
                    <EmptyState
                        title={t("orchestration.none")}
                        description={t("orchestration.noneHint")}
                    />
                ) : (
                    overview.runs.map((run) => <RunCard key={run.id} run={run} onError={setError} />)
                )}
            </section>

            {creating ? <NewRunDialog onClose={() => setCreating(false)} /> : null}
        </div>
    );
}

function NeedRow({
    need,
    objective,
    onError
}: {
    need: RunsOverview["needs"][number];
    objective: string;
    onError: (error: string | null) => void;
}) {
    const t = useTranslations("agents");
    const router = useRouter();
    const [busy, startTransition] = useTransition();
    const [answer, setAnswer] = useState("");

    const act = (work: () => Promise<{ error?: string }>) =>
        startTransition(() => {
            void runAction(work, onError).then((result) => {
                if (result?.error) onError(result.error);
                else {
                    onError(null);
                    setAnswer("");
                    router.refresh();
                }
            });
        });

    return (
        <Card>
            <CardBody className="space-y-2">
                <p className="truncate text-xs text-muted-foreground" title={objective}>
                    {objective}
                </p>
                {need.kind === "gate" ? (
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={need.title}>
                                {need.title}
                            </p>
                            <p className="text-sm">{need.question || t("orchestration.gateDefault")}</p>
                        </div>
                        <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                                act(() =>
                                    resolveGateAction({ runId: need.runId, taskId: need.taskId, approved: true })
                                )
                            }
                        >
                            <Check className="size-4 shrink-0" />
                            {t("orchestration.approve")}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                                act(() =>
                                    resolveGateAction({ runId: need.runId, taskId: need.taskId, approved: false })
                                )
                            }
                        >
                            <X className="size-4 shrink-0" />
                            {t("orchestration.reject")}
                        </Button>
                    </div>
                ) : null}
                {need.kind === "question" ? (
                    <div className="space-y-2">
                        <p className="whitespace-pre-wrap break-words text-sm">{need.body}</p>
                        <Textarea
                            value={answer}
                            onChange={(event) => setAnswer(event.target.value)}
                            placeholder={t("orchestration.answerPlaceholder")}
                            aria-label={t("orchestration.answerPlaceholder")}
                        />
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                aria-disabled={busy || !answer.trim()}
                                disabled={busy || !answer.trim()}
                                onClick={() =>
                                    act(() =>
                                        answerQuestionAction({
                                            runId: need.runId,
                                            messageId: need.messageId,
                                            text: answer
                                        })
                                    )
                                }
                            >
                                {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                {t("orchestration.send")}
                            </Button>
                        </div>
                    </div>
                ) : null}
                {need.kind === "compare" ? (
                    <div className="flex items-center gap-3">
                        <p className="min-w-0 flex-1 truncate text-sm" title={need.title}>
                            {t("orchestration.compareReady", { count: need.count, title: need.title })}
                        </p>
                        <Button asChild size="sm" variant="secondary">
                            <Link href={`/apps/agents/orchestration/compare/${need.groupId}`}>
                                <GitCompare className="size-4 shrink-0" />
                                {t("orchestration.compare")}
                            </Link>
                        </Button>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

function RunCard({ run, onError }: { run: Run; onError: (error: string | null) => void }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [busy, startTransition] = useTransition();
    const [confirming, setConfirming] = useState(false);
    const [adding, setAdding] = useState(false);

    // Columns by depth: a task sits one column right of what it waits for.
    const depths = [...new Set(run.tasks.map((task) => task.depth))].sort((a, b) => a - b);
    const titleOf = new Map(run.tasks.map((task) => [task.id, task.title]));
    const runStatus = (RUN_STATUSES as readonly string[]).includes(run.status) ? run.status : "active";

    const cancel = () =>
        startTransition(() => {
            void runAction(() => cancelRunAction(run.id), onError).then((result) => {
                setConfirming(false);
                if (result?.error) onError(result.error);
                else router.refresh();
            });
        });

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium" title={run.objective}>
                        {run.objective}
                    </p>
                    <Badge>{t(`orchestration.runStatus.${runStatus as (typeof RUN_STATUSES)[number]}`)}</Badge>
                    {run.coordinatorSessionId ? (
                        <Button asChild size="sm" variant="ghost">
                            <Link href={`/polar?session=${run.coordinatorSessionId}`}>
                                {t("orchestration.coordinator")}
                            </Link>
                        </Button>
                    ) : null}
                    {run.status === "active" ? (
                        <>
                            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                                <Plus className="size-4 shrink-0" />
                                {t("orchestration.addTask")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                                <Square className="size-4 shrink-0" />
                                {t("orchestration.cancelRun")}
                            </Button>
                        </>
                    ) : null}
                </div>

                {run.tasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {run.coordinatorSessionId
                            ? t("orchestration.planning")
                            : t("orchestration.noTasks")}
                    </p>
                ) : (
                    <div className="flex gap-3 overflow-x-auto pb-1">
                        {depths.map((depth) => (
                            <div key={depth} className="w-64 shrink-0 space-y-2">
                                {run.tasks
                                    .filter((task) => task.depth === depth)
                                    .map((task) => (
                                        <TaskNode key={task.id} task={task} titleOf={titleOf} />
                                    ))}
                            </div>
                        ))}
                    </div>
                )}
            </CardBody>

            {confirming ? (
                <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("orchestration.cancelTitle")}</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">{t("orchestration.cancelBody")}</p>
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setConfirming(false)}>
                                {tcommon("actions.cancel")}
                            </Button>
                            <Button variant="danger" disabled={busy} onClick={cancel}>
                                {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                {t("orchestration.cancelRun")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
            {adding ? <AddTaskDialog runId={run.id} onClose={() => setAdding(false)} /> : null}
        </Card>
    );
}

function TaskNode({ task, titleOf }: { task: Task; titleOf: Map<string, string> }) {
    const t = useTranslations("agents");
    const status = (STATUSES as readonly string[]).includes(task.status)
        ? (task.status as (typeof STATUSES)[number])
        : "pending";
    const word =
        status === "blocked" && task.blockedBy === "gate"
            ? t("orchestration.status.gate")
            : status === "dispatched" && task.sessionState === "queued"
              ? t("orchestration.status.queued")
              : t(`orchestration.status.${status}`);
    const after = task.dependsOn.map((id) => titleOf.get(id)).filter(Boolean);

    return (
        <div
            className={`space-y-1 rounded-md bg-muted/40 p-2 ${task.chosen ? "ring-1 ring-success" : ""}`}
        >
            <p className="truncate text-sm" title={task.title}>
                {task.title}
            </p>
            <p className={`text-xs ${STATUS_TONE[status]}`}>
                {word}
                {task.chosen ? ` - ${t("orchestration.kept")}` : ""}
            </p>
            {after.length > 0 ? (
                <p className="truncate text-xs text-muted-foreground" title={after.join(", ")}>
                    {t("orchestration.after", { tasks: after.join(", ") })}
                </p>
            ) : null}
            {task.result && status !== "completed" ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">{agentText(t, task.result)}</p>
            ) : null}
            {task.sessionId ? (
                <Link
                    href={`/polar?session=${task.sessionId}`}
                    className="text-xs text-muted-foreground underline"
                >
                    {t("orchestration.openSession")}
                </Link>
            ) : null}
        </div>
    );
}

function NewRunDialog({ onClose }: { onClose: () => void }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [agents, setAgents] = useState<AgentOption[] | null>(null);
    const [repos, setRepos] = useState<{ id: string; name: string }[]>([]);
    const [objective, setObjective] = useState("");
    const [repoId, setRepoId] = useState("");
    const [baseRef, setBaseRef] = useState("");
    const [cli, setCli] = useState("claude");
    const [coordinator, setCoordinator] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        void polls.sessionChoices().then((loaded) => {
            setAgents(loaded.agents);
            setRepos(loaded.repos);
            setRepoId((current) => current || (loaded.repos[0]?.id ?? ""));
        });
    }, []);

    const ready = objective.trim() !== "" && repoId !== "";
    const submit = () =>
        startTransition(() => {
            void runAction(
                () =>
                    createRunAction({
                        objective,
                        repoId,
                        baseRef,
                        cli: agentOf(cli),
                        coordinator
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else {
                    router.refresh();
                    onClose();
                }
            });
        });

    return (
        <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("orchestration.newRun")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                            {t("orchestration.form.objective")} *
                        </span>
                        <Textarea
                            value={objective}
                            onChange={(event) => setObjective(event.target.value)}
                            placeholder={t("orchestration.form.objectivePlaceholder")}
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                            {t("sessions.form.repository")} *
                        </span>
                        <PagedPicker<RepoOption>
                            read={repoOptionsAction}
                            scope={{}}
                            cache="agent-session-repos"
                            value={repoId || null}
                            selectedLabel={repos.find((repo) => repo.id === repoId)?.name}
                            onValueChange={setRepoId}
                            placeholder={t("text.pickRepository")}
                            searchPlaceholder={t("sessions.form.repoSearch")}
                            emptyText={t("sessions.form.repoEmpty")}
                            aria-label={t("sessions.form.repository")}
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                            {t("sessions.form.branch")}
                        </span>
                        <Input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                            {t("sessions.form.agent")}
                        </span>
                        <AgentSelect
                            options={agents ?? []}
                            value={cli}
                            onChange={setCli}
                            disabled={agents === null}
                        />
                    </label>
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm">{t("orchestration.form.coordinator")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("orchestration.form.coordinatorHint")}
                            </p>
                        </div>
                        <Switch checked={coordinator} onChange={setCoordinator} />
                    </div>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={busy || !ready} aria-disabled={busy || !ready}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("orchestration.form.start")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AddTaskDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [agents, setAgents] = useState<AgentOption[] | null>(null);
    const [title, setTitle] = useState("");
    const [spec, setSpec] = useState("");
    const [gate, setGate] = useState("");
    const [picked, setPicked] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        void polls.sessionChoices().then((loaded) => {
            // One row per agent: the compare is between agents, not accounts.
            const seen = new Set<string>();
            const distinct = loaded.agents.filter((option) =>
                seen.has(option.cli) ? false : (seen.add(option.cli), true)
            );
            setAgents(distinct);
            setPicked((current) => (current.length > 0 ? current : distinct.slice(0, 1).map((a) => a.cli)));
        });
    }, []);

    const toggle = (cli: string) =>
        setPicked((current) =>
            current.includes(cli) ? current.filter((value) => value !== cli) : [...current, cli]
        );
    const ready = title.trim() !== "" && spec.trim() !== "" && picked.length > 0;
    const submit = () =>
        startTransition(() => {
            void runAction(() => addTaskAction({ runId, title, spec, gate, agents: picked }), setError).then(
                (result) => {
                    if (!result) return;
                    if (result.error) setError(result.error);
                    else {
                        router.refresh();
                        onClose();
                    }
                }
            );
        });

    return (
        <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("orchestration.addTask")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("orchestration.form.taskTitle")} *</span>
                        <Input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("orchestration.form.spec")} *</span>
                        <Textarea value={spec} onChange={(event) => setSpec(event.target.value)} />
                    </label>
                    <fieldset className="space-y-1">
                        <legend className="text-xs text-muted-foreground">{t("orchestration.form.agents")} *</legend>
                        {(agents ?? []).map((option) => (
                            <label key={option.cli} className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={picked.includes(option.cli)}
                                    onChange={() => toggle(option.cli)}
                                />
                                <span className="min-w-0 truncate" title={option.label}>{option.label}</span>
                            </label>
                        ))}
                        <p className="text-xs text-muted-foreground">{t("orchestration.form.agentsHint")}</p>
                    </fieldset>
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("orchestration.form.gate")}</span>
                        <Input
                            value={gate}
                            maxLength={500}
                            onChange={(event) => setGate(event.target.value)}
                            placeholder={t("orchestration.form.gatePlaceholder")}
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={busy || !ready} aria-disabled={busy || !ready}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {picked.length > 1 ? t("orchestration.form.addCompare") : t("orchestration.form.add")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
