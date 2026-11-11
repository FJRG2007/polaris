"use client";

import { runAction } from "@/lib/run-action";
import { ExecutionPicker } from "./execution-picker";
import { useEffect, useState, useTransition } from "react";
import { RepoSettingsFields } from "./repo-settings-fields";
import type { AgentRepoView } from "@/lib/agents/agent-repo-service";
import { updateRepoConfigAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea,
    isDirty
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";
import {
    AGENT_EFFORTS,
    AGENT_PUSH_POLICIES,
    AGENT_SHELL_POLICIES,
    DEFAULT_REVIEW,
    type AgentExecution,
    type AgentGateMode,
    type AgentPolicy,
    type AgentPushPolicy,
    type AgentShellPolicy,
    type ExecutionAdvice,
    type ResolvedReview,
    type ReviewSettings
} from "@polaris/core";
import { ReviewFields } from "@/components/agents/review-fields";
import * as polls from "./repos-polls";

/** Everything about one repository that is worth changing after it is added. */
export function RepoDialog({ repo, onClose }: { repo: AgentRepoView; onClose: () => void }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const [execution, setExecution] = useState<AgentExecution>(repo.execution);
    const [poolId, setPoolId] = useState<string | null>(repo.poolId);
    const [model, setModel] = useState(repo.model);
    const [effort, setEffort] = useState(repo.effort);
    const [push, setPush] = useState<AgentPushPolicy>(repo.push as AgentPushPolicy);
    const [shell, setShell] = useState<AgentShellPolicy>(repo.shell as AgentShellPolicy);
    const [pullRequests, setPullRequests] = useState<boolean | null>(repo.pullRequests);
    const [issues, setIssues] = useState<boolean | null>(repo.issues);
    const [gate, setGate] = useState<AgentGateMode | null>(repo.gate as AgentGateMode | null);
    const [review, setReview] = useState<ReviewSettings>(repo.review);
    const [inheritedReview, setInheritedReview] = useState<ResolvedReview>(DEFAULT_REVIEW);
    const [setupScript, setSetupScript] = useState(repo.setupScript);
    const [setupRequired, setSetupRequired] = useState(repo.setupRequired);
    const [advice, setAdvice] = useState<ExecutionAdvice | null>(null);
    const [pools, setPools] = useState<Array<{ id: string; name: string }>>([]);
    const [allPools, setAllPools] = useState<Array<{ id: string; name: string }>>([]);
    const [policy, setPolicy] = useState<AgentPolicy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void (async () => {
            const result = await polls.repoAdvice({
                repoFullName: repo.repoFullName,
                isPrivate: repo.isPrivate
            });
            setAdvice(result.advice ?? null);
            setPools(result.pools ?? []);
            setAllPools(result.allPools ?? []);
            setPolicy(result.policy ?? null);
            if (result.review) setInheritedReview(result.review);
        })();
    }, [repo.repoFullName, repo.isPrivate]);

    // Settings put back to how they were save nothing.
    const unchanged = !isDirty(
        {
            execution: repo.execution,
            poolId: repo.poolId,
            model: repo.model,
            effort: repo.effort,
            push: repo.push,
            shell: repo.shell,
            pullRequests: repo.pullRequests,
            issues: repo.issues,
            gate: repo.gate,
            review: repo.review,
            setupScript: repo.setupScript.trim(),
            setupRequired: repo.setupRequired
        },
        {
            execution,
            poolId,
            model,
            effort,
            push,
            shell,
            pullRequests,
            issues,
            gate,
            review,
            setupScript: setupScript.trim(),
            setupRequired
        }
    );

    const save = () => {
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        updateRepoConfigAction({
                            repoId: repo.id,
                            config: {
                                execution,
                                poolId,
                                model,
                                effort,
                                push,
                                shell,
                                enabled: repo.enabled,
                                pullRequests,
                                issues,
                                gate,
                                review
                            },
                            setup: { script: setupScript, required: setupRequired }
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
                        allPools={allPools}
                        poolId={poolId}
                        onChange={setExecution}
                        onPoolChange={setPoolId}
                    />

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("repos.model")}</label>
                        <Input value={model} onChange={(event) => setModel(event.target.value)} />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("repoDialog.effort")}</label>
                        <Select
                            value={effort}
                            onValueChange={setEffort}
                            options={AGENT_EFFORTS.map((value) => ({ value, label: value }))}
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("repoDialog.git")}</label>
                        <Select
                            value={push}
                            onValueChange={(next) => setPush(next as AgentPushPolicy)}
                            options={AGENT_PUSH_POLICIES.map((value) => ({
                                value,
                                label: agentWord(t, "pushPolicy", value)
                            }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            {agentWord(t, "pushPolicyNote", push)}
                        </p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-sm font-medium">{t("repoDialog.shell")}</label>
                        <Select
                            value={shell}
                            onValueChange={(next) => setShell(next as AgentShellPolicy)}
                            options={AGENT_SHELL_POLICIES.map((value) => ({
                                value,
                                label: agentWord(t, "shellPolicy", value)
                            }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            {agentWord(t, "shellPolicyNote", shell)}
                        </p>
                        {!repo.isPrivate && shell === "enabled" ? (
                            <p className="text-xs text-warning">{t("repoDialog.publicShell")}</p>
                        ) : null}
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

                    <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">{t("review.title")}</p>
                            <p className="text-xs text-muted-foreground">{t("review.intro")}</p>
                        </div>
                        <ReviewFields value={review} inherited={inheritedReview} onChange={setReview} />
                    </section>

                    <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor="repo-setup-script">
                            {t("repoDialog.setup")}
                        </label>
                        <Textarea
                            id="repo-setup-script"
                            rows={4}
                            maxLength={8000}
                            spellCheck={false}
                            className="font-mono text-xs"
                            value={setupScript}
                            onChange={(event) => setSetupScript(event.target.value)}
                            placeholder={t("repoDialog.setupPlaceholder")}
                        />
                        <p className="text-xs text-muted-foreground">{t("repoDialog.setupHint")}</p>
                    </div>

                    {setupScript.trim() ? (
                        <div className="flex items-center gap-2">
                            <Switch
                                checked={setupRequired}
                                onChange={setSetupRequired}
                                aria-label={t("repoDialog.setupRequired")}
                            />
                            <span className="text-sm">{t("repoDialog.setupRequired")}</span>
                        </div>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tcommon("actions.cancel")}
                    </Button>
                    <Button onClick={save} disabled={pending || unchanged}>
                        {pending ? t("rules.saving") : t("rules.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
