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
import { AgentSelect, CUSTOM_CHOICE, SignInNotice } from "@/components/agents/agent-select";
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

/** How often a live session is re-read. A session reports through its hooks, so
 *  this is only how quickly the list notices - fast enough that "needs you" is
 *  seen, slow enough that a screen left open all day is not a load. */
const REFRESH_MS = 4000;

/** What each state looks like, and how loudly. `waiting` is the only one that
 *  gets a colour meant to be noticed across a room. */
const TONE: Record<core.AgentSessionState, string> = {
    starting: "text-muted-foreground",
    working: "text-violet-400",
    waiting: "text-amber-400",
    idle: "text-foreground",
    stopped: "text-muted-foreground",
    failed: "text-red-400"
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
            });
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setStarting(true)}>
                    <Play className="size-4 shrink-0" />
                    Start a session
                </Button>
            </div>

            {ordered.length === 0 ? (
                <EmptyState
                    icon={<Bot />}
                    title="No sessions yet"
                    description="A session puts a coding agent in a branch of its own, on a machine you already have. You can watch it work, answer its questions, and send it the next thing."
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
                                        {session.detail || session.repoFullName || "A workspace"}
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
                                            {session.hostName ?? "a server"}
                                        </span>
                                    ) : (
                                        "this box"
                                    )}
                                </span>
                                <span className={`shrink-0 text-xs ${TONE[session.state]}`}>
                                    {core.sessionStateLabel(session.state, session.lastEventAt !== null)}
                                </span>
                                {core.isSessionOver(session.state) ? null : (
                                    <Button size="sm" variant="ghost" onClick={() => stop(session)}>
                                        <Square className="size-4 shrink-0" />
                                        Stop
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
                    <DialogTitle>Start a session</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                What is it working on
                            </span>
                            <Input
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                placeholder="Fix the login redirect"
                            />
                        </label>

                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">Repository</span>
                            <Select
                                value={repoId}
                                onValueChange={setRepoId}
                                options={[
                                    // First, because it is the answer that needs
                                    // nothing set up. Somebody who just wants an
                                    // agent should not have to connect a
                                    // repository to get one.
                                    { value: NO_REPO, label: "No repository - just open the agent" },
                                    ...(choices?.repos ?? []).map((repo) => ({
                                        value: repo.id,
                                        label: repo.name
                                    }))
                                ]}
                                placeholder="Pick a repository"
                            />
                        </label>

                        {workspace ? (
                            <p className="text-xs text-muted-foreground">
                                It opens on a machine of your own with an empty directory and
                                nothing checked out. The machine keeps its home, so what you
                                install and sign in to stays there for next time.
                            </p>
                        ) : null}
                        {noRepos ? (
                            <p className="text-xs text-muted-foreground">
                                Nothing is connected yet. Add one under{" "}
                                <Link href="/apps/agents/repos" className="underline">
                                    Repositories
                                </Link>{" "}
                                to have an agent work in it.
                            </p>
                        ) : null}

                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">Agent</span>
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
                                <span className="text-xs text-muted-foreground">
                                    The command that starts it. It has to already be installed on
                                    the machine.
                                </span>
                                <Input
                                    value={command}
                                    onChange={(event) => setCommand(event.target.value)}
                                    placeholder="my-agent"
                                />
                            </label>
                        ) : null}

                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">Where it runs</span>
                            <Select
                                value={place}
                                onValueChange={(value) => setPlace(value as core.AgentSessionPlace)}
                                options={core.AGENT_SESSION_PLACES.map((option) => ({
                                    value: option,
                                    label: core.AGENT_SESSION_PLACE_LABELS[option]
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
                                    <p className="text-sm">Use the machine everybody shares</p>
                                    <p className="text-xs text-muted-foreground">
                                        {sharedHome
                                            ? "One home for the whole deployment: whatever is signed in there signs you in, and the files anybody leaves are the files you find."
                                            : "It opens on a machine of your own, with your logins and your files. Nobody else reaches it."}
                                    </p>
                                </div>
                                <Switch checked={sharedHome} onChange={setSharedHome} />
                            </div>
                        ) : null}

                        {place === "host" ? (
                            <label className="block space-y-1">
                                <span className="text-xs text-muted-foreground">Which server</span>
                                <Select
                                    value={hostId}
                                    onValueChange={setHostId}
                                    options={(choices?.hosts ?? []).map((host) => ({
                                        value: host.id,
                                        label: host.name
                                    }))}
                                    placeholder="Pick a server"
                                />
                            </label>
                        ) : null}

                        {workspace ? null : (
                            <label className="block space-y-1">
                                <span className="text-xs text-muted-foreground">
                                    Branch to start from. Leave it empty for the repository&apos;s
                                    default.
                                </span>
                                <Input
                                    value={baseRef}
                                    onChange={(event) => setBaseRef(event.target.value)}
                                    placeholder="main"
                                />
                            </label>
                        )}

                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                What to start with. Leave it empty to open the agent and type into
                                it yourself.
                            </span>
                            <Textarea
                                value={prompt}
                                onChange={(event) => setPrompt(event.target.value)}
                                rows={4}
                                placeholder="Read the failing test in auth.test.ts and fix what it is telling you."
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
                                <p className="text-sm">Let it work without asking</p>
                                <p className="text-xs text-muted-foreground">
                                    {enigma
                                        ? "Enigma is on, so this is one of the things it settles: your own policies decide what the agent may run without asking, and Polaris does not add anything on top."
                                        : place === "host"
                                        ? "This server is your machine: the agent runs as the account Polaris enrolled, beside everything that account can reach. Off, it asks before each command - which means taking the terminal to answer it."
                                          : "It runs in a container of its own holding one checkout, removed when the session ends. Off, it waits on its own permission prompts, and nobody is watching a container."}
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
                                <p className="text-sm">Work to your Enigma standards</p>
                                <p className="text-xs text-muted-foreground">
                                    Installs your policies, conventions and guardrails into the
                                    session before the agent starts. Its own settings come from this
                                    repository and from Agents settings.
                                </p>
                            </div>
                            <Switch checked={enigma} onChange={setEnigma} />
                        </div>

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={busy || !title || !repoId || unlinked !== null}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Start
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The picker's value is a tool and an account, joined.
 *
 * One control rather than two, because they are one decision: "run this with
 * that subscription". Split here on the way to the server, which stores them
 * apart - the tool decides what is launched and the account decides what signs
 * it in.
 */
function agentOf(value: string): string {
    return value.split(":")[0] ?? value;
}

/** The account half, or null for "whichever would resolve". */
function accountOf(value: string): string | null {
    return value.split(":")[1] ?? null;
}
