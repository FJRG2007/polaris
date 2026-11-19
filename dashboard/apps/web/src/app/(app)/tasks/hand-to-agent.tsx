"use client";

/**
 * Giving a task to a coding agent.
 *
 * The handoff people actually want: a task already says what needs doing and in
 * which words, so retyping it into an agent is transcription. This takes the task
 * as it stands, opens a session on a branch of its own, and leaves a comment on
 * the task saying where the work is happening - so the board keeps answering
 * "what is happening with this" without anybody updating it.
 *
 * Only the two things that cannot be inferred are asked for. Which repository,
 * because a task does not name one, and which model, because that is a
 * preference - picked from the person's sources as in Polar Code; the server
 * works out which tool runs it. Everything else - the title, the prompt, the
 * branch - comes from the task.
 */

import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useTransition } from "react";
import { PagedPicker } from "@/components/paged-picker";
import type { RepoOption } from "@/lib/agents/repo-options";
import {
    agentHandoffRepoOptionsAction,
    handTaskToAgentAction,
    startRunFromTasksAction
} from "./actions";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { SignInNotice } from "@/components/agents/agent-select";
import { CodeModelPicker } from "@/components/polar/code-model-picker";
import type { CodePick, CodeSource } from "@/lib/polar/agents/code-sources";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    SegmentedControl,
    Textarea
} from "@polaris/ui";
import * as polls from "./tasks-polls";

interface Props {
    taskId: string;
    reference: string;
    name: string;
    description: string;
}

export function HandToAgent({ taskId, reference, name, description }: Props) {
    const [open, setOpen] = useState(false);
    const t = useTranslations("tasksDetail");
    const gate = useHandoffGate();
    const label = gate.reason ?? t("agent.giveThis");

    return (
        <>
            {/* The reason sits on a wrapper: a disabled button shows no tooltip. */}
            <span title={label} className="inline-flex">
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={label}
                    disabled={!gate.usable}
                    onClick={() => setOpen(true)}
                >
                    <Bot className="size-4" />
                    <span className="hidden sm:inline">{t("agent.give")}</span>
                </Button>
            </span>
            {open ? (
                <HandOffDialog
                    taskId={taskId}
                    reference={reference}
                    name={name}
                    description={description}
                    onClose={() => setOpen(false)}
                />
            ) : null}
        </>
    );
}

export function HandOffDialog({
    taskId,
    reference,
    name,
    description,
    onClose
}: Props & { onClose: () => void }) {
    const t = useTranslations("tasksDetail");
    const tc = useTranslations("common");
    const choices = useHandoffChoices();
    const { repos, repoId, pick, source } = choices;
    // Seeded from the task and then editable. What a task says is usually the
    // right brief and occasionally needs a sentence of context that would have
    // been noise on the board.
    const [prompt, setPrompt] = useState(
        [`${reference}: ${name}`, description, "", t("agent.promptTail")]
            .filter((line) => line !== "")
            .join("\n\n")
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const router = useRouter();

    const submit = () => {
        startTransition(() => {
            void runAction(
                () =>
                    handTaskToAgentAction({
                        repoId,
                        title: `${reference} ${name}`.slice(0, 80),
                        // The server resolves the tool from this.
                        pick,
                        place: "local",
                        hostId: null,
                        baseRef: "",
                        prompt,
                        taskId
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.id) router.push(`/polar?session=${encodeURIComponent(result.id)}`);
                else if (result.error) setError(result.error);
            });
        });
    };

    const noRepos = repos !== null && repos.length === 0;

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("agent.title", { reference })}</DialogTitle>
                </DialogHeader>

                {noRepos ? (
                    <p className="text-sm text-muted-foreground">{t("agent.noRepos")}</p>
                ) : (
                    <div className="space-y-3">
                        <HandoffFields choices={choices} busy={busy} />
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                {t("agent.prompt")}
                            </span>
                            <Textarea
                                value={prompt}
                                onChange={(event) => setPrompt(event.target.value)}
                                rows={6}
                            />
                        </label>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={
                            busy ||
                            noRepos ||
                            !repoId ||
                            !prompt.trim() ||
                            pick === null ||
                            source?.readiness === "missing"
                        }
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("agent.start")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
/**
 * What both handoff dialogs ask before anything else: the repositories, the
 * person's model sources, and which tool cannot be signed in. A handoff is
 * always a session on this box, so there is no "already signed in on that
 * server" case to leave room for.
 */
function useHandoffChoices() {
    const [repos, setRepos] = useState<{ id: string; name: string }[] | null>(null);
    const [agents, setAgents] = useState<AgentOption[]>([]);
    const [sources, setSources] = useState<CodeSource[] | null>(null);
    const [repoId, setRepoId] = useState("");
    const [pick, setPick] = useState<CodePick | null>(null);

    useEffect(() => {
        void polls.handoffChoices().then((choices) => {
            setRepos(choices.repos);
            setAgents(choices.agents);
            setSources(choices.sources);
            // A source that can sign in first; its own default model.
            const first =
                choices.sources.find((source) => source.readiness === "ready") ?? choices.sources[0];
            setPick(
                (current) =>
                    current ??
                    (first
                        ? { source: first.key, provider: first.models[0]?.provider ?? "", model: null }
                        : null)
            );
            setRepoId((current) => current || (choices.repos[0]?.id ?? ""));
        });
    }, []);

    const source = sources?.find((entry) => entry.key === pick?.source) ?? null;
    const unlinked =
        source?.readiness === "missing"
            ? (agents.find(
                  (agent) =>
                      agent.cli === source.engines[0] &&
                      (agent.accountId ?? null) === source.accountId &&
                      agent.readiness === "missing"
              ) ?? null)
            : null;
    return { repos, sources, repoId, setRepoId, pick, setPick, source, unlinked };
}

type HandoffChoices = ReturnType<typeof useHandoffChoices>;

/** The repository and model fields, with the sign-in notice under them. */
function HandoffFields({ choices, busy }: { choices: HandoffChoices; busy: boolean }) {
    const t = useTranslations("tasksDetail");
    const { repos, sources, repoId, setRepoId, pick, setPick, unlinked } = choices;
    return (
        <>
            <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("agent.repository")}</span>
                <PagedPicker<RepoOption>
                    read={agentHandoffRepoOptionsAction}
                    scope={{}}
                    cache="task-handoff-repos"
                    value={repoId || null}
                    selectedLabel={repos?.find((repo) => repo.id === repoId)?.name}
                    onValueChange={(value) => setRepoId(value)}
                    placeholder={t("agent.pickRepository")}
                    searchPlaceholder={t("agent.repoSearch")}
                    emptyText={t("agent.repoEmpty")}
                    aria-label={t("agent.repository")}
                />
            </label>
            <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("agent.agent")}</span>
                <CodeModelPicker
                    sources={sources}
                    value={pick}
                    onChange={setPick}
                    automatic={false}
                    disabled={busy || sources?.length === 0}
                />
            </label>
            {unlinked ? <SignInNotice agent={unlinked} /> : null}
        </>
    );
}

/** Where the runs started from Tasks are watched when no single session is. */
const RUNS_PAGE = "/automations/code-review/orchestration";

/**
 * Giving a selection of tasks to agents: one coordinator that takes them as its
 * plan, or one worker per task. Each task's status then follows the session
 * working on it, until somebody moves it by hand.
 */
export function HandSelectionDialog({
    tasks,
    onClose
}: {
    tasks: readonly { id: string }[];
    onClose: () => void;
}) {
    const t = useTranslations("tasksDetail");
    const tc = useTranslations("common");
    const choices = useHandoffChoices();
    const [mode, setMode] = useState<"coordinator" | "workers">(
        tasks.length > 1 ? "coordinator" : "workers"
    );
    const [brief, setBrief] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const router = useRouter();
    const noRepos = choices.repos !== null && choices.repos.length === 0;
    const tooMany = tasks.length > RUN_TASKS_MAX;

    const submit = () => {
        startTransition(() => {
            void runAction(
                () =>
                    startRunFromTasksAction({
                        taskIds: tasks.map((task) => task.id),
                        mode,
                        repoId: choices.repoId,
                        pick: choices.pick,
                        brief
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else if (result.sessionId)
                    router.push(`/polar?session=${encodeURIComponent(result.sessionId)}`);
                else if (result.runId) router.push(RUNS_PAGE);
            });
        });
    };

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("agent.runTitle", { count: tasks.length })}</DialogTitle>
                </DialogHeader>
                {noRepos ? (
                    <p className="text-sm text-muted-foreground">{t("agent.noRepos")}</p>
                ) : (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <span className="block text-xs text-muted-foreground">{t("agent.mode")}</span>
                            <SegmentedControl<"coordinator" | "workers">
                                size="sm"
                                aria-label={t("agent.mode")}
                                value={mode}
                                onValueChange={setMode}
                                options={[
                                    { value: "coordinator", label: t("agent.modeCoordinator") },
                                    { value: "workers", label: t("agent.modeWorkers") }
                                ]}
                            />
                            <p className="text-xs text-muted-foreground">
                                {mode === "coordinator"
                                    ? t("agent.modeCoordinatorHint")
                                    : t("agent.modeWorkersHint", { count: tasks.length })}
                            </p>
                        </div>
                        <HandoffFields choices={choices} busy={busy} />
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("agent.brief")}</span>
                            <Textarea
                                value={brief}
                                onChange={(event) => setBrief(event.target.value)}
                                placeholder={t("agent.briefPlaceholder")}
                                maxLength={4000}
                                rows={4}
                            />
                        </label>
                        <p className="text-xs text-muted-foreground">{t("agent.follows")}</p>
                        {tooMany ? (
                            <p className="text-sm text-danger">
                                {t("agent.tooMany", { count: RUN_TASKS_MAX })}
                            </p>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={
                            busy ||
                            noRepos ||
                            tooMany ||
                            !choices.repoId ||
                            choices.pick === null ||
                            choices.source?.readiness === "missing"
                        }
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("agent.start")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The most tasks one run takes, as the server holds it. */
const RUN_TASKS_MAX = 20;

/**
 * Whether a handoff can start for this account, from the same answer the
 * starts refuse on: Agents access, and a repository of their own. Unusable
 * until that answer is in, so nothing is offered and then refused.
 */
export function useHandoffGate(): { usable: boolean; reason: string | null } {
    const t = useTranslations("tasksDetail");
    const [answer, setAnswer] = useState<{ allowed: boolean; repos: number } | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        void polls
            .handoffChoices(controller.signal)
            .then((choices) => setAnswer({ allowed: choices.allowed, repos: choices.repos.length }))
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    if (!answer) return { usable: false, reason: null };
    if (!answer.allowed) return { usable: false, reason: t("agent.noAgents") };
    if (answer.repos === 0) return { usable: false, reason: t("agent.noRepos") };
    return { usable: true, reason: null };
}
