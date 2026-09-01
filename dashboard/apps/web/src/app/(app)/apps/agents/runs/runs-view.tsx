"use client";

import { RunState } from "../run-state";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useEffect, useState, useTransition } from "react";
import { cancelRunAction, startRunAction } from "../actions";
import type { AgentRunView } from "@/lib/agents/agent-run-service";
import { Check, ExternalLink, Loader2, Play, Square, TriangleAlert } from "lucide-react";
import { GATE_STEP_LABELS, type GateStepReport } from "@/lib/agents/agent-gate";
import { AGENT_EXECUTION_LABELS, AGENT_TRIGGER_LABELS, isTerminalRunState } from "@polaris/core";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Textarea
} from "@polaris/ui";

/**
 * Run history, and the one place a run is started by hand.
 *
 * A run's row links out to whatever it produced rather than restating it: the
 * pull request, the issue, or the workflow run. The agent writes its own account
 * of what it did into the pull request, which is where the person reviewing it is
 * already looking.
 */
/** How often a run that is still going is re-read. The gate reports a step at a
 *  time and a screen that only moved on reload would make a working pipeline
 *  look stuck. */
const REFRESH_MS = 5000;

export function RunsView({ runs, repos }: { runs: AgentRunView[]; repos: string[] }) {
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const router = useRouter();

    // Only while something is actually moving. A screen of finished runs polls
    // nothing.
    const live = runs.some((run) => !isTerminalRunState(run.state));
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => router.refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, router]);

    const cancel = (run: AgentRunView) => {
        startTransition(() => {
            void runAction(() => cancelRunAction({ runId: run.id }), setError);
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            {repos.length > 0 ? (
                <div className="flex justify-end">
                    <Button size="sm" onClick={() => setStarting(true)}>
                        <Play className="size-4 shrink-0" />
                        Start a run
                    </Button>
                </div>
            ) : null}

            <Card>
                <CardBody className="p-0">
                    {runs.length === 0 ? (
                        <p className="px-4 py-10 text-sm text-muted-foreground">
                            Nothing has run yet. Mention the app in an issue or a pull request, add
                            an automation, or start a run here.
                        </p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr className="border-b border-white/5">
                                    <th className="w-full max-w-0 px-4 py-2 font-medium">
                                        Repository
                                    </th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">
                                        Started by
                                    </th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">
                                        Ran on
                                    </th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">
                                        State
                                    </th>
                                    <th className="px-4 py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {runs.map((run) => (
                                    <tr key={run.id}>
                                        <td className="w-full max-w-0 px-4 py-3">
                                            <div className="truncate">
                                                <a
                                                    href={target(run)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="hover:underline"
                                                >
                                                    {run.repoFullName}
                                                    {run.prNumber
                                                        ? ` #${run.prNumber}`
                                                        : run.issueNumber
                                                          ? ` #${run.issueNumber}`
                                                          : ""}
                                                </a>
                                            </div>
                                            {run.error ? (
                                                <p className="mt-1 text-xs text-red-400">
                                                    {run.error}
                                                </p>
                                            ) : null}
                                            <GateSteps steps={run.gateSteps} />
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                                            {AGENT_TRIGGER_LABELS[run.trigger]}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                                            {/* The job itself, which is where the log is. Without
                                                this, working out why a run failed meant finding the
                                                repository, opening Actions and guessing which run
                                                was ours. */}
                                            {jobUrl(run) ? (
                                                <a
                                                    href={jobUrl(run) as string}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center gap-1 hover:underline"
                                                    title="Open the job that ran this"
                                                >
                                                    {AGENT_EXECUTION_LABELS[run.execution]}
                                                    <ExternalLink className="size-3 shrink-0" />
                                                </a>
                                            ) : (
                                                AGENT_EXECUTION_LABELS[run.execution]
                                            )}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3">
                                            <RunState state={run.state} />
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-right">
                                            {isTerminalRunState(run.state) ? null : (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label="Stop this run"
                                                    title="Stop this run"
                                                    onClick={() => cancel(run)}
                                                >
                                                    <Square className="size-4 shrink-0" />
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </CardBody>
            </Card>

            {starting ? <StartRunDialog repos={repos} onClose={() => setStarting(false)} /> : null}
        </div>
    );
}

/**
 * What the quality gate is doing, under the run it belongs to.
 *
 * Shown as it happens rather than only once it is over: the gate can hold a push
 * for minutes, and a run that looks idle for that long reads as broken. A failed
 * step keeps what it said, because that is the thing somebody has to act on.
 */
function GateSteps({ steps }: { steps: GateStepReport[] }) {
    if (steps.length === 0) return null;
    return (
        <ul className="mt-1.5 space-y-1">
            {steps.map((step) => (
                <li key={`${step.step}-${step.at}`} className="text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                        {step.state === "running" ? (
                            <Loader2 className="size-3 shrink-0 animate-spin" />
                        ) : step.state === "passed" ? (
                            <Check className="size-3 shrink-0 text-emerald-400" />
                        ) : (
                            <TriangleAlert className="size-3 shrink-0 text-red-400" />
                        )}
                        {GATE_STEP_LABELS[step.step]}
                    </span>
                    {step.state === "failed" && step.detail ? (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface/60 px-2 py-1 text-[0.6875rem] text-red-300">
                            {step.detail}
                        </pre>
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

/**
 * The job that ran it, when there is one to open.
 *
 * Null until GitHub's own run id is recorded, which happens on the run's first
 * call home - a job that died before that has nothing to link to, and a run on
 * the Polaris box has no GitHub job at all; both then read as plain text rather
 * than a link that goes nowhere.
 */
function jobUrl(run: AgentRunView): string | null {
    if (!run.githubRunId) return null;
    return `https://github.com/${run.repoFullName}/actions/runs/${run.githubRunId}`;
}

/** Where a run's work ended up. The pull request when there is one, else the
 *  issue, else the repository. */
function target(run: AgentRunView): string {
    const base = `https://github.com/${run.repoFullName}`;
    if (run.prNumber) return `${base}/pull/${run.prNumber}`;
    if (run.issueNumber) return `${base}/issues/${run.issueNumber}`;
    return base;
}

function StartRunDialog({ repos, onClose }: { repos: string[]; onClose: () => void }) {
    const [repoFullName, setRepoFullName] = useState(repos[0] ?? "");
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const start = () => {
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () => startRunAction({ repoFullName, prompt, issueNumber: null, mode: null }),
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
                    <DialogTitle>Start a run</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">Repository</label>
                        <Select
                            value={repoFullName}
                            onValueChange={setRepoFullName}
                            options={repos.map((name) => ({ value: name, label: name }))}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-sm font-medium">What should it do?</label>
                        <Textarea
                            rows={5}
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            placeholder="Add a regression test for the timezone bug in the report exporter, and open a pull request."
                        />
                    </div>
                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={start}
                        disabled={!repoFullName || prompt.trim().length === 0 || pending}
                    >
                        {pending ? "Starting..." : "Start"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
