"use client";

import Link from "next/link";
import { RepoDialog } from "./repo-dialog";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { AddRepoDialog } from "./add-repo-dialog";
import { removeRepoAction, setRepoEnabledAction } from "../actions";
import type { AgentRepoView } from "@/lib/agents/agent-repo-service";
import { Check, Plus, Settings2, TriangleAlert, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, ConfirmDeleteDialog, Switch } from "@polaris/ui";
import { AGENT_WORKFLOW_PATH, needsWorkflowFile } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentText, agentWord } from "@/lib/agents/words";

/**
 * The repositories the agent is on.
 *
 * One row per repository, with the two things somebody actually changes on it -
 * whether it is on, and where it runs - reachable without opening anything. The
 * rest is behind the settings dialog, because it is read far more often than it
 * is edited.
 */
export function ReposView({ repos, providers }: { repos: AgentRepoView[]; providers: string[] }) {
    const t = useTranslations("agents");
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<AgentRepoView | null>(null);
    const [removing, setRemoving] = useState<AgentRepoView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const toggle = (repo: AgentRepoView, enabled: boolean) => {
        startTransition(() => {
            void runAction(() => setRepoEnabledAction({ repoId: repo.id, enabled }), setError);
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" />
                    {t("repos.add")}
                </Button>
            </div>

            {repos.length === 0 ? (
                <Card>
                    <CardBody className="py-10 text-sm text-muted-foreground">
                        {t("repos.none")}
                    </CardBody>
                </Card>
            ) : (
                <Card>
                    <CardBody className="p-0">
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr className="border-b border-white/5">
                                    <th className="w-full max-w-0 px-4 py-2 font-medium">{t("sessions.form.repository")}</th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">{t("repos.runsOn")}</th>
                                    <th className="whitespace-nowrap px-4 py-2 font-medium">{t("repos.model")}</th>
                                    <th className="px-4 py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {repos.map((repo) => (
                                    <tr key={repo.id}>
                                        <td className="w-full max-w-0 px-4 py-3">
                                            <div className="truncate">
                                                <a
                                                    href={`https://github.com/${repo.repoFullName}`}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="hover:underline"
                                                >
                                                    {repo.repoFullName}
                                                </a>
                                                {repo.isPrivate ? (
                                                    <Badge variant="neutral" className="ml-2">
                                                        {t("repos.private")}
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            {repo.error ? <p className="mt-1 text-xs text-danger">{agentText(t, repo.error)}</p> : null}
                                        </td>
                                        <td
                                            className="whitespace-nowrap px-4 py-3 text-muted-foreground"
                                            title={agentWord(t, "executionNote", repo.execution)}
                                        >
                                            {agentWord(t, "execution", repo.execution)}
                                            {repo.poolName ? (
                                                <span className="ml-1 text-xs">({repo.poolName})</span>
                                            ) : null}
                                            {/* The two GitHub-scheduled executions need a file in the
                                                repository, and whether it is there is the difference
                                                between a repository that will run and one that will
                                                fail at its first dispatch. */}
                                            {needsWorkflowFile(repo.execution) ? (
                                                <a
                                                    href={`https://github.com/${repo.repoFullName}/blob/HEAD/${AGENT_WORKFLOW_PATH}`}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="mt-0.5 flex items-center gap-1 text-xs hover:underline"
                                                    title={
                                                        repo.workflowInstalledAt
                                                            ? t("repos.workflowKept")
                                                            : t("repos.workflowMissing")
                                                    }
                                                >
                                                    {repo.workflowInstalledAt ? (
                                                        <Check className="size-3 shrink-0 text-success" />
                                                    ) : (
                                                        <TriangleAlert className="size-3 shrink-0 text-warning" />
                                                    )}
                                                    {t("repos.workflow")}
                                                </a>
                                            ) : null}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{repo.model}</td>
                                        <td className="whitespace-nowrap px-4 py-3">
                                            <div className="flex items-center justify-end gap-1">
                                                <Switch
                                                    checked={repo.enabled}
                                                    onChange={(next: boolean) => toggle(repo, next)}
                                                    aria-label={repo.enabled ? t("repos.turnOff") : t("repos.turnOn")}
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("repos.settings")}
                                                    title={t("repos.settings")}
                                                    onClick={() => setEditing(repo)}
                                                >
                                                    <Settings2 className="size-4 shrink-0" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("repos.remove")}
                                                    title={t("repos.remove")}
                                                    onClick={() => setRemoving(repo)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardBody>
                </Card>
            )}

            {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t.rich("repos.noProvider", {
                        link: (chunks) => (
                            <Link href="/account/ai-keys" className="underline">
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            ) : null}

            {adding ? <AddRepoDialog onClose={() => setAdding(false)} /> : null}
            {editing ? <RepoDialog repo={editing} onClose={() => setEditing(null)} /> : null}
            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.repoFullName}
                    kind={t("repos.kind")}
                    requireTyping={false}
                    description={t("repos.removeBody")}
                    confirmLabel={t("repos.remove")}
                    onConfirm={async () => {
                        await runAction(() => removeRepoAction({ repoId: removing.id }), setError);
                        setRemoving(null);
                    }}
                />
            ) : null}
        </div>
    );
}
