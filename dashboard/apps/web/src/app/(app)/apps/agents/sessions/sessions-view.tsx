"use client";

/**
 * The sessions list, and the one place a session is started.
 *
 * A session is a conversation rather than a job, so the list is sorted by what it
 * wants from you rather than by when it happened: anything blocked on a person
 * comes first, then anything still working, then everything that has finished.
 * The whole point of running an agent somewhere other than your own laptop is not
 * having to watch it, which only works if the screen says which one needs you.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useEffect, useState, useTransition } from "react";
import type { SessionView } from "@/lib/agents/session-service";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import {
    accountOf,
    agentOf,
    AgentSelect,
    CUSTOM_CHOICE,
    machineOf,
    SignInNotice
} from "@/components/agents/agent-select";
import { Bot, CircleDot, Loader2, Play, Server, Square } from "lucide-react";
import { sessionChoicesAction, startSessionAction, stopSessionAction } from "./actions";
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
    EmptyState,
    Input,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentText, agentWord, sessionStateWord } from "@/lib/agents/words";

/** How often a live session is re-read. A session reports through its hooks, so
 *  this is only how quickly the list notices - fast enough that "needs you" is
 *  seen, slow enough that a screen left open all day is not a load. */
const REFRESH_MS = 4000;

/** What each state looks like, and how loudly. `waiting` is the only one that
 *  gets a colour meant to be noticed across a room. */
const TONE: Record<core.AgentSessionState, string> = {
    starting: "text-muted-foreground",
    working: "text-violet-400",
    waiting: "text-warning",
    idle: "text-foreground",
    stopped: "text-muted-foreground",
    failed: "text-danger"
};

/** Blocked on a person first, then still going, then done. */
const ORDER: Record<core.AgentSessionState, number> = {
    waiting: 0,
    working: 1,
    starting: 2,
    idle: 3,
    failed: 4,
    stopped: 5
};

interface Choices {
    agents: AgentOption[];
    repos: { id: string; name: string }[];
    hosts: { id: string; name: string }[];
    /** Whether this deployment offers a machine everybody shares. */
    sharedWorkspace: boolean;
}

export function SessionsView({ sessions }: { sessions: SessionView[] }) {
    const t = useTranslations("agents");
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const router = useRouter();

    const live = sessions.some((session) => !core.isSessionOver(session.state));
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => router.refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, router]);

    const ordered = [...sessions].sort((a, b) => ORDER[a.state] - ORDER[b.state]);

    const stop = (session: SessionView) => {
        startTransition(() => {
            void runAction(() => stopSessionAction(session.id), setError).then((result) => {
                if (result?.error) setError(result.error);
                // See the session page's own Stop: the row is answered now
                // rather than on the next poll.
                else router.refresh();
            });
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setStarting(true)}>
                    <Play className="size-4 shrink-0" />
                    {t("sessions.start")}
                </Button>
            </div>

            {ordered.length === 0 ? (
                <EmptyState
                    icon={<Bot />}
                    title={t("sessions.none")}
                    description={t("sessions.noneHint")}
                />
            ) : (
                <div className="space-y-2">
                    {ordered.map((session) => (
                        <Card key={session.id}>
                            <CardBody className="flex flex-wrap items-center gap-3">
                                <CircleDot className={`size-4 shrink-0 ${TONE[session.state]}`} />
                                <div className="min-w-0 flex-1">
                                    <Link
                                        href={`/apps/agents/sessions/${session.id}`}
                                        className="block truncate text-sm font-medium hover:underline"
                                    >
                                        {session.title}
                                    </Link>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {(session.detail ? agentText(t, session.detail) : "") ||
                                            session.repoFullName ||
                                            t("sessions.workspace")}
                                    </p>
                                </div>
                                <Badge variant="neutral" className="shrink-0">
                                    {core.agentCliById(session.cli)?.label ??
                                        session.command ??
                                        session.cli}
                                </Badge>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {session.place === "host" ? (
                                        <span className="flex items-center gap-1">
                                            <Server className="size-3 shrink-0" />
                                            {session.hostName ?? t("sessions.aServer")}
                                        </span>
                                    ) : (
                                        t("sessions.thisBox")
                                    )}
                                </span>
                                <span className={`shrink-0 text-xs ${TONE[session.state]}`}>
                                    {sessionStateWord(t, session.state, session.lastEventAt !== null)}
                                </span>
                                {core.isSessionOver(session.state) ? null : (
                                    <Button size="sm" variant="ghost" onClick={() => stop(session)}>
                                        <Square className="size-4 shrink-0" />
                                        {t("sessions.stop")}
                                    </Button>
                                )}
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}

            {starting ? <StartDialog onClose={() => setStarting(false)} /> : null}
        </div>
    );
}

/**
 * Starting one.
 *
 * The form asks for the four things that cannot be guessed and nothing else. The
 * first prompt is optional on purpose: a session with one starts working, which
 * is "give this to Claude", and a session without one comes up at its prompt,
 * which is "open me a terminal on a branch". Both are ordinary.
 */
/**
 * The repository picker's answer for "none".
 *
 * A sentinel rather than an empty string because the select cannot hold one, and
 * a word rather than a dash so a stored value that ever leaked into a log says
 * what it meant.
 */
const NO_REPO = "workspace";

function StartDialog({ onClose }: { onClose: () => void }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const [choices, setChoices] = useState<Choices | null>(null);
    const [repoId, setRepoId] = useState("");
    const [title, setTitle] = useState("");
    const [cli, setCli] = useState("claude");
    const [command, setCommand] = useState("");
    const [place, setPlace] = useState<core.AgentSessionPlace>("local");
    // The machine everybody shares, where the deployment offers one. Off unless
    // somebody picks it: it holds other people's logins and other people's
    // files, and nothing should land there by default.
    const [sharedHome, setSharedHome] = useState(false);
    const [hostId, setHostId] = useState("");
    const [baseRef, setBaseRef] = useState("");
    const [prompt, setPrompt] = useState("");
    const [enigma, setEnigma] = useState(true);
    // Null until somebody moves it, so a session records that nobody chose
    // rather than recording the default as a decision.
    const [unattended, setUnattended] = useState<boolean | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const router = useRouter();

    useEffect(() => {
        void sessionChoicesAction().then((loaded) => {
            setChoices(loaded);
            // A workspace when there is nothing connected, which is now a real
            // answer rather than a dead end: an agent on a machine of your own
            // with nothing checked out needs no repository at all.
            setRepoId((current) => current || (loaded.repos[0]?.id ?? NO_REPO));
        });
    }, []);

    // No repository named. Everything a checkout implies - a branch, a task, a
    // clone - goes with it.
    const workspace = repoId === NO_REPO;

    const submit = () => {
        startTransition(() => {
            void runAction(
                () =>
                    startSessionAction({
                        repoId: workspace ? null : repoId,
                        title,
                        cli: agentOf(cli),
                        accountId: accountOf(cli),
                        useMachineLogin: machineOf(cli),
                        command: agentOf(cli) === core.CUSTOM_AGENT_CLI ? command : undefined,
                        place,
                        sharedHome: place === "local" && sharedHome,
                        hostId: place === "host" ? hostId : null,
                        baseRef: workspace ? "" : baseRef,
                        prompt,
                        taskId: null,
                        unattended,
                        // Only what was decided here. Everything else stays null so it
                        // keeps following the repository and the instance.
                        enigma: { enabled: enigma }
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                // A session that was created but would not start is still worth
                // opening: the reason it failed is on it, and it is the only place
                // that says what was attempted.
                if (result.id) router.push(`/apps/agents/sessions/${result.id}`);
                else if (result.error) setError(result.error);
                else onClose();
            });
        });
    };

    const noRepos = choices !== null && choices.repos.length === 0;
    const agents = [...(choices?.agents ?? []), CUSTOM_CHOICE];
    // The chosen tool, when nothing here can sign it in. Drives the notice under
    // the picker and disables Start - the server refuses this too, and would say
    // the same thing, but finding out after the click is finding out too late to
    // do anything about it without losing the form.
    const unlinked =
        agents.find((agent) => agent.key === cli && agent.readiness === "missing") ?? null;

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sessions.start")}</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("sessions.form.title")}</span>
                        <Input
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder={t("sessions.form.titlePlaceholder")}
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("sessions.form.repository")}</span>
                        <Select
                            value={repoId}
                            onValueChange={setRepoId}
                            options={[
                                // First, because it is the answer that needs
                                // nothing set up. Somebody who just wants an
                                // agent should not have to connect a
                                // repository to get one.
                                { value: NO_REPO, label: t("sessions.form.noRepo") },
                                ...(choices?.repos ?? []).map((repo) => ({
                                    value: repo.id,
                                    label: repo.name
                                }))
                            ]}
                            placeholder={t("text.pickRepository")}
                        />
                    </label>

                    {workspace ? (
                        <p className="text-xs text-muted-foreground">{t("sessions.form.workspaceHint")}</p>
                    ) : null}
                    {noRepos ? (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("sessions.form.noRepos", {
                                link: (chunks) => (
                                    <Link href="/apps/agents/repos" className="underline">
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    ) : null}

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("sessions.form.agent")}</span>
                        <AgentSelect
                            options={agents}
                            value={cli}
                            onChange={setCli}
                            disabled={choices === null}
                        />
                    </label>

                    {unlinked ? <SignInNotice agent={unlinked} /> : null}

                    {cli === core.CUSTOM_AGENT_CLI ? (
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("sessions.form.command")}</span>
                            <Input
                                value={command}
                                onChange={(event) => setCommand(event.target.value)}
                                placeholder="my-agent" // i18n-ignore an example command
                            />
                        </label>
                    ) : null}

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("sessions.form.where")}</span>
                        <Select
                            value={place}
                            onValueChange={(value) => setPlace(value as core.AgentSessionPlace)}
                            options={core.AGENT_SESSION_PLACES.map((option) => ({
                                value: option,
                                label: agentWord(t, "sessionPlace", option)
                            }))}
                        />
                    </label>

                    {/* Only where the deployment offers one, and only for a
                            container Polaris owns - an enrolled server already
                            has a home of its own. The copy says what it means
                            rather than what it is called: one home, so the
                            logins and the files are everybody's. */}
                    {place === "local" && choices?.sharedWorkspace ? (
                        <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                            <div className="min-w-0">
                                <p className="text-sm">{t("sessions.form.shared")}</p>
                                <p className="text-xs text-muted-foreground">
                                    {sharedHome ? t("sessions.form.sharedOn") : t("sessions.form.sharedOff")}
                                </p>
                            </div>
                            <Switch checked={sharedHome} onChange={setSharedHome} />
                        </div>
                    ) : null}

                    {place === "host" ? (
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("sessions.form.whichServer")}</span>
                            <Select
                                value={hostId}
                                onValueChange={setHostId}
                                options={(choices?.hosts ?? []).map((host) => ({
                                    value: host.id,
                                    label: host.name
                                }))}
                                placeholder={t("sessions.form.pickServer")}
                            />
                        </label>
                    ) : null}

                    {workspace ? null : (
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("sessions.form.branch")}</span>
                            <Input
                                value={baseRef}
                                onChange={(event) => setBaseRef(event.target.value)}
                                placeholder="main" // i18n-ignore a branch name
                            />
                        </label>
                    )}

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("sessions.form.prompt")}</span>
                        <Textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            rows={4}
                            placeholder={t("sessions.form.promptPlaceholder")}
                        />
                    </label>

                    {/* The one control on this form that changes what the
                            agent may do to a machine, so it says which machine.
                            In a container it is the difference between working
                            and sitting on a permission prompt nobody will answer;
                            on somebody's server it is the difference between a
                            tool that asks and a tool that does not. */}
                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                        <div className="min-w-0">
                            <p className="text-sm">{t("sessions.form.unattended")}</p>
                            <p className="text-xs text-muted-foreground">
                                {enigma
                                    ? t("sessions.form.unattendedEnigma")
                                    : place === "host"
                                      ? t("sessions.form.unattendedHost")
                                      : t("sessions.form.unattendedContainer")}
                            </p>
                        </div>
                        <Switch
                            checked={core.agentRunsUnattended(place, unattended)}
                            onChange={setUnattended}
                            disabled={enigma}
                        />
                    </div>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                        <div className="min-w-0">
                            <p className="text-sm">{t("sessions.form.enigma")}</p>
                            <p className="text-xs text-muted-foreground">{t("sessions.form.enigmaHint")}</p>
                        </div>
                        <Switch checked={enigma} onChange={setEnigma} />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={busy || !title || !repoId || unlinked !== null}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("sessions.form.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
