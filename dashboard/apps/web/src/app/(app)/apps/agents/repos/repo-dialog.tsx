"use client";

import { runAction } from "@/lib/run-action";
import { ExecutionPicker } from "./execution-picker";
import { useEffect, useState, useTransition } from "react";
import type { AgentRepoView } from "@/lib/agents/agent-repo-service";
import { adviseRepoAction, updateRepoConfigAction } from "../actions";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";
import {
    AGENT_EFFORTS,
    AGENT_PUSH_POLICIES,
    AGENT_PUSH_POLICY_LABELS,
    AGENT_PUSH_POLICY_NOTES,
    AGENT_SHELL_POLICIES,
    AGENT_SHELL_POLICY_LABELS,
    AGENT_SHELL_POLICY_NOTES,
    type AgentExecution,
    type AgentPushPolicy,
    type AgentShellPolicy,
    type ExecutionAdvice
} from "@polaris/core";

/** Everything about one repository that is worth changing after it is added. */
export function RepoDialog({ repo, onClose }: { repo: AgentRepoView; onClose: () => void }) {
    const [execution, setExecution] = useState<AgentExecution>(repo.execution);
    const [poolId, setPoolId] = useState<string | null>(repo.poolId);
    const [model, setModel] = useState(repo.model);
    const [effort, setEffort] = useState(repo.effort);
    const [push, setPush] = useState<AgentPushPolicy>(repo.push as AgentPushPolicy);
    const [shell, setShell] = useState<AgentShellPolicy>(repo.shell as AgentShellPolicy);
    const [advice, setAdvice] = useState<ExecutionAdvice | null>(null);
    const [pools, setPools] = useState<Array<{ id: string; name: string }>>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void (async () => {
            const result = await adviseRepoAction({ repoFullName: repo.repoFullName, isPrivate: repo.isPrivate });
            setAdvice(result.advice ?? null);
            setPools(result.pools ?? []);
        })();
    }, [repo.repoFullName, repo.isPrivate]);

    const save = () => {
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        updateRepoConfigAction({
                            repoId: repo.id,
                            config: { execution, poolId, model, effort, push, shell, enabled: repo.enabled }
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
                    <DialogTitle>{repo.repoFullName}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <ExecutionPicker
                        value={execution}
                        advice={advice}
                        pools={pools}
                        poolId={poolId}
                        onChange={setExecution}
                        onPoolChange={setPoolId}
                    />

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Model</label>
                        <Input value={model} onChange={(event) => setModel(event.target.value)} />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Reasoning effort</label>
                        <Select
                            value={effort}
                            onValueChange={setEffort}
                            options={AGENT_EFFORTS.map((value) => ({ value, label: value }))}
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Git access</label>
                        <Select
                            value={push}
                            onValueChange={(next) => setPush(next as AgentPushPolicy)}
                            options={AGENT_PUSH_POLICIES.map((value) => ({
                                value,
                                label: AGENT_PUSH_POLICY_LABELS[value]
                            }))}
                        />
                        <p className="text-xs text-muted-foreground">{AGENT_PUSH_POLICY_NOTES[push]}</p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">Shell</label>
                        <Select
                            value={shell}
                            onValueChange={(next) => setShell(next as AgentShellPolicy)}
                            options={AGENT_SHELL_POLICIES.map((value) => ({
                                value,
                                label: AGENT_SHELL_POLICY_LABELS[value]
                            }))}
                        />
                        <p className="text-xs text-muted-foreground">{AGENT_SHELL_POLICY_NOTES[shell]}</p>
                        {!repo.isPrivate && shell === "enabled" ? (
                            <p className="text-xs text-amber-400">
                                This repository is public, so anybody can open a pull request the agent then reads. A
                                full shell hands whatever it runs the provider keys in its environment.
                            </p>
                        ) : null}
                    </div>

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={pending}>
                        {pending ? "Saving..." : "Save"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
