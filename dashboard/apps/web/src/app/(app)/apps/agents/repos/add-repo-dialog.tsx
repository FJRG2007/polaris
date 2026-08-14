"use client";

import { Lock } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { ExecutionPicker } from "./execution-picker";
import { GitHubMark } from "@/components/brand-icons";
import { ModelPicker } from "@/components/model-picker";
import { RepoSettingsFields } from "./repo-settings-fields";
import { useCallback, useState, useTransition } from "react";
import { RepoPicker, type PickerRepo } from "@/components/repo-picker";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Select } from "@polaris/ui";
import {
    adviseRepoAction,
    agentModelChoices,
    enableRepoAction,
    listAgentRepoChoices,
    searchAgentRepoChoices
} from "../actions";
import {
    AGENT_EFFORTS,
    policyAllowsVisibility,
    type AgentExecution,
    type AgentGateMode,
    type AgentPolicy,
    type AgentPushPolicy,
    type AgentShellPolicy,
    type ExecutionAdvice
} from "@polaris/core";

/**
 * Turning the agent on for a repository.
 *
 * The repository is picked first because everything after it depends on what the
 * repository is: a public one gets a different recommendation and a different
 * shell default than a private one, its account may carry settings of its own,
 * and asking for any of that before knowing would mean asking twice.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
    const [repo, setRepo] = useState<PickerRepo | null>(null);
    const [providers, setProviders] = useState<string[]>([]);
    const [pools, setPools] = useState<Array<{ id: string; name: string }>>([]);
    const [allPools, setAllPools] = useState<Array<{ id: string; name: string }>>([]);
    const [advice, setAdvice] = useState<ExecutionAdvice | null>(null);
    const [policy, setPolicy] = useState<AgentPolicy | null>(null);

    const [execution, setExecution] = useState<AgentExecution>("server");
    const [poolId, setPoolId] = useState<string | null>(null);
    const [model, setModel] = useState("");
    const [effort, setEffort] = useState<string>("medium");
    const [pullRequests, setPullRequests] = useState<boolean | null>(null);
    const [issues, setIssues] = useState<boolean | null>(null);
    const [gate, setGate] = useState<AgentGateMode | null>(null);
    // Not on the form: both are set from what the tiers decided, and changed
    // afterwards from the repository's own settings. Kept here so a tier that
    // answered them is not silently discarded on save.
    const [push, setPush] = useState<AgentPushPolicy>("restricted");
    const [shell, setShell] = useState<AgentShellPolicy>("restricted");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [pending, startTransition] = useTransition();

    const listRepos = useCallback(() => listAgentRepoChoices(), []);

    // Picking a repository is what makes everything else answerable, so it is all
    // asked for then rather than on every keystroke of the search.
    const pick = (picked: PickerRepo) => {
        setRepo(picked);
        setLoading(true);
        setError(null);
        void (async () => {
            const result = await adviseRepoAction({ repoFullName: picked.fullName, isPrivate: picked.private });
            setLoading(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            setAdvice(result.advice ?? null);
            setPools(result.pools ?? []);
            setAllPools(result.allPools ?? []);
            setProviders(result.providers ?? []);
            setPolicy(result.policy ?? null);
            if (result.defaults) {
                setExecution(result.defaults.execution);
                setPoolId(result.defaults.poolId);
                setEffort(result.defaults.effort);
                setModel(result.defaults.model);
                setPush(result.defaults.push);
                setShell(result.defaults.shell);
            }
        })();
    };

    const save = () => {
        if (!repo) return;
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        enableRepoAction({
                            repoFullName: repo.fullName,
                            installationId: repo.fullName.split("/")[0] ?? "",
                            isPrivate: repo.private,
                            config: {
                                execution,
                                poolId,
                                model,
                                effort,
                                push,
                                shell,
                                enabled: true,
                                pullRequests,
                                issues,
                                gate
                            }
                        }),
                    setError
                );
                if (result && !result.error) onClose();
                else if (result?.error) setError(result.error);
            })();
        });
    };

    // The tiers above can turn a whole visibility off, and enabling a repository
    // they exclude produces one that looks enabled and never runs. Said here
    // rather than only on save.
    const excluded = repo && policy ? !policyAllowsVisibility(policy, repo.private) : false;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add a repository</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">Repository</label>
                        {repo ? (
                            <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                                <GitHubMark className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-sm" title={repo.fullName}>{repo.fullName}</span>
                                {repo.private && <Lock className="size-3.5 shrink-0 text-muted-foreground" />}
                                <Button type="button" variant="ghost" size="sm" onClick={() => setRepo(null)}>
                                    Change
                                </Button>
                            </div>
                        ) : (
                            <RepoPicker
                                cacheKey="agents"
                                autoFocus
                                list={listRepos}
                                search={searchAgentRepoChoices}
                                onPick={pick}
                            />
                        )}
                    </div>

                    {excluded ? (
                        <p className="text-xs text-amber-400">
                            {repo?.private ? "Private" : "Public"} repositories are turned off for this account. Turn
                            them back on under Agents settings, or the agent will never run here.
                        </p>
                    ) : null}

                    {repo && !loading ? (
                        <>
                            <ExecutionPicker
                                value={execution}
                                advice={advice}
                                pools={pools}
                                allPools={allPools}
                                poolId={poolId}
                                onChange={setExecution}
                                onPoolChange={setPoolId}
                            />

                            <div className="space-y-1">
                                <label className="text-sm font-medium">Model</label>
                                <ModelPicker
                                    value={model || null}
                                    onChange={(next) => setModel(next ?? "")}
                                    load={agentModelChoices}
                                    inheritLabel={null}
                                    placeholder={providers.length === 0 ? "No provider connected" : "Pick a model"}
                                />
                                {providers.length === 0 ? (
                                    <p className="text-xs text-amber-400">
                                        Connect a model provider under Integrations first.
                                    </p>
                                ) : null}
                            </div>

                            <div className="space-y-1">
                                <label className="text-sm font-medium">Reasoning effort</label>
                                <Select
                                    value={effort}
                                    onValueChange={setEffort}
                                    options={AGENT_EFFORTS.map((value) => ({ value, label: value }))}
                                />
                            </div>

                            <RepoSettingsFields
                                policy={policy}
                                pullRequests={pullRequests}
                                issues={issues}
                                gate={gate}
                                onPullRequests={setPullRequests}
                                onIssues={setIssues}
                                onGate={setGate}
                            />

                            <p className="text-xs text-muted-foreground">
                                The agent starts on feature branches only and cannot push to the default branch. Change
                                that, and the rules that start it, from the repository&apos;s settings afterwards.
                            </p>
                        </>
                    ) : null}

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={!repo || !model || loading || pending}>
                        {pending ? "Adding..." : "Add"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
