"use client";

import { runAction } from "@/lib/run-action";
import { ExecutionPicker } from "./execution-picker";
import { useEffect, useState, useTransition } from "react";
import { adviseRepoAction, enableRepoAction, listAgentRepoChoices } from "../actions";
import { AGENT_EFFORTS, defaultShellPolicy, type AgentExecution, type ExecutionAdvice } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Select } from "@polaris/ui";

/** Models offered by default, one per provider Polaris carries a credential for.
 *  A slug the runtime gained later still works: the field accepts any well-formed
 *  one, and an unknown model fails at dispatch naming itself. */
const MODELS: Record<string, { label: string; slug: string }> = {
    anthropic: { label: "Claude (Anthropic)", slug: "anthropic/claude-opus" },
    openai: { label: "GPT (OpenAI)", slug: "openai/gpt-luna" },
    "google-ai": { label: "Gemini (Google)", slug: "google/gemini-3.1-flash-lite" },
    openrouter: { label: "OpenRouter", slug: "openrouter/minimax-m2.5" }
};

/**
 * Turning the agent on for a repository.
 *
 * The repository is picked first because everything after it depends on what the
 * repository is: a public one gets a different recommendation and a different
 * shell default than a private one, and asking for those before knowing would
 * mean asking twice.
 */
export function AddRepoDialog({ onClose }: { onClose: () => void }) {
    const [repos, setRepos] = useState<Array<{ fullName: string; private: boolean }>>([]);
    const [providers, setProviders] = useState<string[]>([]);
    const [pools, setPools] = useState<Array<{ id: string; name: string }>>([]);
    const [advice, setAdvice] = useState<ExecutionAdvice | null>(null);

    const [repoFullName, setRepoFullName] = useState("");
    const [execution, setExecution] = useState<AgentExecution>("server");
    const [poolId, setPoolId] = useState<string | null>(null);
    const [model, setModel] = useState("");
    const [effort, setEffort] = useState<string>("medium");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const selected = repos.find((repo) => repo.fullName === repoFullName) ?? null;

    // The repository list is the one slow read here, so it starts immediately and
    // the dialog renders around it rather than behind it.
    useEffect(() => {
        void (async () => {
            const result = await listAgentRepoChoices();
            if (result.error) setError(result.error);
            setRepos(result.repos);
        })();
    }, []);

    // Picking a repository is what makes advice possible, so it is asked for then
    // rather than on every keystroke.
    useEffect(() => {
        if (!selected) return;
        void (async () => {
            const result = await adviseRepoAction({ repoFullName: selected.fullName, isPrivate: selected.private });
            if (result.error) {
                setError(result.error);
                return;
            }
            setAdvice(result.advice ?? null);
            setPools(result.pools ?? []);
            setProviders(result.providers ?? []);
            if (result.advice) setExecution(result.advice.execution);
            setPoolId(result.pools?.[0]?.id ?? null);
            const first = (result.providers ?? []).map((slug) => MODELS[slug]).find(Boolean);
            if (first) setModel(first.slug);
        })();
    }, [selected]);

    const save = () => {
        if (!selected) return;
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        enableRepoAction({
                            repoFullName: selected.fullName,
                            installationId: selected.fullName.split("/")[0] ?? "",
                            isPrivate: selected.private,
                            config: {
                                execution,
                                poolId,
                                model,
                                effort,
                                push: "restricted",
                                shell: defaultShellPolicy(selected.private),
                                enabled: true
                            }
                        }),
                    setError
                );
                if (result && !result.error) onClose();
                else if (result?.error) setError(result.error);
            })();
        });
    };

    const modelOptions = providers.map((slug) => MODELS[slug]).filter(Boolean) as Array<{ label: string; slug: string }>;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add a repository</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-1">
                        <label className="text-sm font-medium">Repository</label>
                        <Select
                            value={repoFullName}
                            onValueChange={setRepoFullName}
                            placeholder={repos.length === 0 ? "Reading your repositories..." : "Pick a repository"}
                            options={repos.map((repo) => ({
                                value: repo.fullName,
                                label: repo.private ? `${repo.fullName} (private)` : repo.fullName
                            }))}
                        />
                    </div>

                    {selected ? (
                        <>
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
                                <Select
                                    value={model}
                                    onValueChange={setModel}
                                    placeholder={modelOptions.length === 0 ? "No provider connected" : "Pick a model"}
                                    options={modelOptions.map((entry) => ({ value: entry.slug, label: entry.label }))}
                                />
                                {modelOptions.length === 0 ? (
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

                            <p className="text-xs text-muted-foreground">
                                The agent starts on feature branches only and cannot push to the default branch. Change
                                that, and the rules that start it, from the repository&apos;s settings afterwards.
                            </p>
                        </>
                    ) : null}

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={!selected || !model || pending}>
                        {pending ? "Adding..." : "Add"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
