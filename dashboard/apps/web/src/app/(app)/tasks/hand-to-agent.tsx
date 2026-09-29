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
 * because a task does not name one, and which agent, because that is a
 * preference. Everything else - the title, the prompt, the branch - comes from
 * the task.
 */

import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useTransition } from "react";
import { agentHandoffChoicesAction, handTaskToAgentAction } from "./actions";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import {
    accountOf,
    agentOf,
    AgentSelect,
    machineOf,
    SignInNotice
} from "@/components/agents/agent-select";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Textarea
} from "@polaris/ui";

interface Props {
    taskId: string;
    reference: string;
    name: string;
    description: string;
}

export function HandToAgent({ taskId, reference, name, description }: Props) {
    const [open, setOpen] = useState(false);
    const t = useTranslations("tasksDetail");

    return (
        <>
            <Button
                size="sm"
                variant="ghost"
                title={t("agent.giveThis")}
                aria-label={t("agent.giveThis")}
                onClick={() => setOpen(true)}
            >
                <Bot className="size-4" />
                <span className="hidden sm:inline">{t("agent.give")}</span>
            </Button>
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

function HandOffDialog({
    taskId,
    reference,
    name,
    description,
    onClose
}: Props & { onClose: () => void }) {
    const t = useTranslations("tasksDetail");
    const tc = useTranslations("common");
    const [repos, setRepos] = useState<{ id: string; name: string }[] | null>(null);
    const [agents, setAgents] = useState<AgentOption[]>([]);
    const [repoId, setRepoId] = useState("");
    const [cli, setCli] = useState("claude");
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

    useEffect(() => {
        void agentHandoffChoicesAction().then((choices) => {
            setRepos(choices.repos);
            setAgents(choices.agents);
            setRepoId((current) => current || (choices.repos[0]?.id ?? ""));
        });
    }, []);

    const submit = () => {
        startTransition(() => {
            void runAction(
                () =>
                    handTaskToAgentAction({
                        repoId,
                        title: `${reference} ${name}`.slice(0, 80),
                        cli: agentOf(cli),
                        accountId: accountOf(cli),
                        useMachineLogin: machineOf(cli),
                        place: "local",
                        hostId: null,
                        baseRef: "",
                        prompt,
                        taskId
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.id) router.push(`/apps/agents/sessions/${result.id}`);
                else if (result.error) setError(result.error);
            });
        });
    };

    const noRepos = repos !== null && repos.length === 0;
    // The chosen tool, when nothing here can sign it in. A handoff is always a
    // session on this box, so there is no "already signed in on that server"
    // case to leave room for: it would come up at a login prompt, full stop.
    const unlinked =
        agents.find((agent) => agent.key === cli && agent.readiness === "missing") ?? null;

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("agent.title", { reference })}</DialogTitle>
                </DialogHeader>

                {noRepos ? (
                    <p className="text-sm text-muted-foreground">
                        {t("agent.noRepos")}
                    </p>
                ) : (
                    <div className="space-y-3">
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("agent.repository")}</span>
                            <Select
                                value={repoId}
                                onValueChange={setRepoId}
                                options={(repos ?? []).map((repo) => ({
                                    value: repo.id,
                                    label: repo.name
                                }))}
                                placeholder={t("agent.pickRepository")}
                            />
                        </label>
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("agent.agent")}</span>
                            <AgentSelect
                                options={agents}
                                value={cli}
                                onChange={setCli}
                                disabled={agents.length === 0}
                            />
                        </label>
                        {unlinked ? <SignInNotice agent={unlinked} /> : null}
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("agent.prompt")}</span>
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
                        disabled={busy || noRepos || !repoId || !prompt.trim() || unlinked !== null}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("agent.start")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
