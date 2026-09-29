"use client";

/**
 * One card per repository, saying what it may do with the machine and letting
 * somebody change it.
 *
 * The order is the order the questions get asked. Is this repository being served
 * at all, and if not why. What is it allowed to run. Whose code is allowed to be
 * what runs. And only then, what those runs can read - because that answer only
 * matters once the ones above it are settled.
 *
 * Nothing is saved as it is toggled. Widening what may execute on somebody's
 * hardware is not a checkbox that should take effect while a finger is still
 * moving, and a card with unsaved changes says so.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setForkApprovalAction, setRepoPolicyAction } from "./actions";
import type { RunnerRepoView } from "@/lib/runners/runner-repo-config";
import { Github, Globe, Lock, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Switch, cn } from "@polaris/ui";
import { RUNNER_EVENTS, type RunnerEvent, type RunnerRepoPolicy } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { runnerText } from "@/lib/runners/words";
import type { NamespaceKey } from "@/lib/i18n/types";

/** Each event as the catalog names it: `events.<key>.label` and `.note`. */
const EVENT_KEYS: Record<RunnerEvent, string> = {
    push: "push",
    pull_request: "pullRequest",
    workflow_dispatch: "workflowDispatch",
    schedule: "schedule",
    other: "other"
};

interface PoolRepos {
    poolId: string;
    poolName: string;
    hostName: string | null;
    repos: RunnerRepoView[];
}

export function ReposView({ pools }: { pools: PoolRepos[] }) {
    const t = useTranslations("runners");
    const empty = pools.every((pool) => pool.repos.length === 0);
    if (pools.length === 0 || empty) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-2">
                    <p className="text-sm">{t("repos.none")}</p>
                    <p className="max-w-lg text-xs text-muted-foreground">{t("repos.noneHint")}</p>
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/apps/runners">{t("dialog.add")}</Link>
                    </Button>
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            {pools
                .filter((pool) => pool.repos.length > 0)
                .map((pool) => (
                    <section key={pool.poolId} className="flex flex-col gap-3">
                        <h2 className="text-sm font-medium text-muted-foreground">
                            {pool.poolName}
                            {pool.hostName ? ` - ${pool.hostName}` : ""}
                        </h2>
                        {pool.repos.map((repo) => (
                            <RepoCard key={repo.key} poolId={pool.poolId} repo={repo} />
                        ))}
                    </section>
                ))}
        </div>
    );
}

function RepoCard({ poolId, repo }: { poolId: string; repo: RunnerRepoView }) {
    const t = useTranslations("runners");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const eventLabel = (event: RunnerEvent) => t(`events.${EVENT_KEYS[event]}.label` as NamespaceKey<"runners">);
    const eventNote = (event: RunnerEvent) => t(`events.${EVENT_KEYS[event]}.note` as NamespaceKey<"runners">);
    const [pending, startTransition] = useTransition();
    const [draft, setDraft] = useState<RunnerRepoPolicy>(repo.policy);
    const [error, setError] = useState<string | null>(null);

    const dirty =
        draft.allowForks !== repo.policy.allowForks ||
        draft.allowPublic !== repo.policy.allowPublic ||
        draft.secrets !== repo.policy.secrets ||
        draft.events.length !== repo.policy.events.length ||
        draft.events.some((event) => !repo.policy.events.includes(event));

    function toggleEvent(event: RunnerEvent, on: boolean) {
        setDraft((current) => ({
            ...current,
            events: on
                ? RUNNER_EVENTS.filter((name) => name === event || current.events.includes(name))
                : current.events.filter((name) => name !== event)
        }));
    }

    function save() {
        setError(null);
        startTransition(async () => {
            const result = await setRepoPolicyAction({
                poolId,
                key: repo.key,
                events: draft.events,
                allowForks: draft.allowForks,
                allowPublic: draft.allowPublic,
                secrets: draft.secrets
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        // Named after the repository so a pool card can link straight to the one
        // that says why it is not being served.
        <Card id={repo.key} className="scroll-mt-20">
            <CardHeader className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="flex items-center gap-2">
                        <Github className="size-4 text-muted-foreground" />
                        <span className="truncate">{repo.key}</span>
                        {repo.kind === "org" ? <Badge variant="neutral">{t("repos.wholeOrg")}</Badge> : null}
                    </CardTitle>
                    <Visibility repo={repo} />
                </div>
                {dirty ? (
                    <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(repo.policy)}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button size="sm" disabled={pending} onClick={save}>
                            {t("repos.save")}
                        </Button>
                    </div>
                ) : null}
            </CardHeader>

            <CardBody className="flex flex-col gap-4">
                {repo.refusal ? (
                    <Notice tone="warning">
                        <ShieldAlert className="size-4" />
                        <span>{runnerText(t, repo.refusal)}</span>
                    </Notice>
                ) : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}

                {repo.kind === "org" ? (
                    <p className="text-xs text-muted-foreground">{t("repos.orgNote")}</p>
                ) : null}

                <fieldset className="flex flex-col gap-2">
                    <legend className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("repos.whatMayRun")}
                    </legend>
                    {RUNNER_EVENTS.map((event) => (
                        <label key={event} className="flex items-start gap-2 text-sm">
                            <Checkbox
                                checked={draft.events.includes(event)}
                                onChange={(changed) => toggleEvent(event, changed.target.checked)}
                                aria-label={eventLabel(event)}
                            />
                            <span className="flex flex-col">
                                <span>{eventLabel(event)}</span>
                                <span className="text-xs text-muted-foreground">{eventNote(event)}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>

                <Setting
                    label={t("repos.forks")}
                    hint={t("repos.forksHint")}
                    danger={draft.allowForks}
                    checked={draft.allowForks}
                    onChange={(on) => setDraft((current) => ({ ...current, allowForks: on }))}
                />

                {repo.visibility === "public" ? (
                    <Setting
                        label={t("repos.public")}
                        hint={t("repos.publicHint")}
                        danger={draft.allowPublic}
                        checked={draft.allowPublic}
                        onChange={(on) => setDraft((current) => ({ ...current, allowPublic: on }))}
                    />
                ) : null}

                <Setting
                    label={t("repos.secrets")}
                    hint={t("repos.secretsHint")}
                    checked={draft.secrets}
                    onChange={(on) => setDraft((current) => ({ ...current, secrets: on }))}
                />

                {repo.warning ? (
                    <Notice tone="warning">
                        <TriangleAlert className="size-4" />
                        <span>{runnerText(t, repo.warning)}</span>
                    </Notice>
                ) : null}

                {repo.perRepo ? <ForkApproval repo={repo} /> : null}
            </CardBody>
        </Card>
    );
}

/** What GitHub says the repository is. An unknown answer says so rather than
 *  implying private, because "not asked yet" is what it actually means. */
function Visibility({ repo }: { repo: RunnerRepoView }) {
    const t = useTranslations("runners");
    if (repo.visibility === "public") {
        return (
            <span className="flex items-center gap-1 text-xs text-warning">
                <Globe className="size-3.5" />
                {t("repos.publicOnGithub")}
            </span>
        );
    }
    if (repo.visibility === "private") {
        return (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3.5" />
                {t("repos.private")}
            </span>
        );
    }
    return <span className="text-xs text-muted-foreground">{t("repos.unknownVisibility")}</span>;
}

/**
 * GitHub's own approval rule for contributors from outside the repository.
 *
 * This is the layer in front of everything else on this page: it decides whether
 * a stranger's workflow is queued at all, and Polaris only gets a say once it
 * has been. Shown when it is at its loosest, with the offer to tighten it,
 * because that is the case where the guard on the machine is carrying weight it
 * should not have to.
 */
function ForkApproval({ repo }: { repo: RunnerRepoView }) {
    const t = useTranslations("runners");
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    if (!repo.repo || repo.forkApproval !== "first_time_contributors_new_to_github") return null;
    const name = repo.repo;

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="flex items-start gap-2 text-xs">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <span>{t("repos.approvalLoose")}</span>
            </p>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            <Button
                size="sm"
                variant="ghost"
                className="self-start"
                disabled={pending}
                onClick={() => {
                    setError(null);
                    startTransition(async () => {
                        const result = await setForkApprovalAction({
                            owner: repo.owner,
                            repo: name,
                            policy: "all_external_contributors"
                        });
                        if (result.error) {
                            setError(result.error);
                            return;
                        }
                        router.refresh();
                    });
                }}
            >
                {t("repos.requireApproval")}
            </Button>
        </div>
    );
}

function Setting({
    label,
    hint,
    checked,
    danger,
    onChange
}: {
    label: string;
    hint: string;
    checked: boolean;
    danger?: boolean;
    onChange: (on: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <span className="flex flex-col">
                <span className={cn("text-sm", danger && "text-warning")}>{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </span>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </div>
    );
}

function Notice({ tone, children }: { tone: "warning"; children: React.ReactNode }) {
    return (
        <p
            className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                tone === "warning" && "border-warning-edge bg-warning-soft"
            )}
        >
            {children}
        </p>
    );
}
