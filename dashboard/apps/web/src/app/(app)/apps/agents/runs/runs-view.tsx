"use client";

import { RunState } from "../run-state";
import { Play, Square } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { cancelRunAction, startRunAction } from "../actions";
import type { AgentRunView } from "@/lib/agents/agent-run-service";
import { AGENT_EXECUTION_LABELS, AGENT_TRIGGER_LABELS, isTerminalRunState } from "@polaris/core";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
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
export function RunsView({ runs, repos }: { runs: AgentRunView[]; repos: string[] }) {
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

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
                            Nothing has run yet. Mention the app in an issue or a pull request, add an automation, or
                            start a run here.
                        </p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr className="border-b border-white/5">
                                    <th className="w-full max-w-0 px-4 py-2 font-medium">Repository</th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">Started by</th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">Ran on</th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">State</th>
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
                                                    {run.prNumber ? ` #${run.prNumber}` : run.issueNumber ? ` #${run.issueNumber}` : ""}
                                                </a>
                                            </div>
                                            {run.error ? <p className="mt-1 text-xs text-red-400">{run.error}</p> : null}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                                            {AGENT_TRIGGER_LABELS[run.trigger]}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                                            {AGENT_EXECUTION_LABELS[run.execution]}
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
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={start} disabled={!repoFullName || prompt.trim().length === 0 || pending}>
                        {pending ? "Starting..." : "Start"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
