"use client";

/**
 * The top of a service's Source and Build sections, the way Railway opens them:
 * the repository it is connected to (with the branch it follows, its root
 * directory and whether a push deploys it), or the upload or image it runs
 * instead; and the builder that turns it into an image, with why.
 *
 * Both say only what is stored about the service - nothing here is guessed.
 */

import type { ReactNode } from "react";
import * as deployActions from "./actions";
import type { ProjectApp } from "./deploy-view";
import { GitHubMark } from "@/components/brand-icons";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ServiceSourceView } from "@/lib/deploy/service-source";
import { RepoPicker, type PickerRepo } from "@/components/repo-picker";
import { CardError, CardSkeleton, SettingsCard } from "./settings-kit";
import { changeSourceAction, disconnectSourceAction, serviceSourceAction } from "./source-actions";
import { ArrowUpRight, Box, FolderUp, GitBranch, Hammer, Loader2, Pencil, Unplug } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** One fact of the source card: a muted label and its value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface px-3 py-2">
            <dt className="text-[0.6875rem] text-foreground-subtle">{label}</dt>
            <dd className="min-w-0 truncate text-xs font-medium">{children}</dd>
        </div>
    );
}

/** The Source card, drawn from what the server says about the service. */
export function SourceRepositoryView({
    source,
    rootDirectory,
    autoDeploy,
    canConfigure,
    controls
}: {
    source: ServiceSourceView;
    rootDirectory: string | null;
    autoDeploy: boolean;
    canConfigure: boolean;
    /** Change and disconnect, for somebody who may configure the service. */
    controls?: ReactNode;
}) {
    const t = useTranslations("deployService");

    if (source.kind === "repository") {
        const mark =
            source.provider === "github" ? (
                <GitHubMark className="size-5 shrink-0" />
            ) : (
                <GitBranch className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            );
        return (
            <SettingsCard
                entry="repository"
                title={t("sourceCard.repository")}
                description={t("sourceCard.repositoryShort")}
                actions={controls}
            >
                <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    {mark}
                    {source.url ? (
                        <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            title={source.name}
                            className="inline-flex min-w-0 flex-1 items-center gap-1 text-sm font-medium hover:text-primary hover:underline"
                        >
                            <span className="truncate">{source.name}</span>
                            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
                        </a>
                    ) : (
                        <span
                            title={source.name}
                            className="min-w-0 flex-1 truncate text-sm font-medium"
                        >
                            {source.name}
                        </span>
                    )}
                    <CopyButton value={source.name} className="shrink-0" />
                </div>
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Fact label={t("sourceCard.branch")}>
                        <span className="font-mono" title={source.branch || undefined}>
                            {source.branch || t("sourceCard.defaultBranch")}
                        </span>
                    </Fact>
                    <Fact label={t("sourceCard.root")}>
                        <span className="font-mono" title={rootDirectory || undefined}>
                            {rootDirectory?.trim() || t("sourceCard.rootNone")}
                        </span>
                    </Fact>
                    <Fact label={t("sourceCard.onPush")}>
                        <Badge variant={autoDeploy ? "success" : "neutral"}>
                            {autoDeploy ? t("kit.on") : t("kit.off")}
                        </Badge>
                    </Fact>
                </dl>
            </SettingsCard>
        );
    }

    const other =
        source.kind === "upload"
            ? {
                  icon: FolderUp,
                  title: t("sourceCard.upload"),
                  text: source.uploaded
                      ? t("sourceCard.uploadShort")
                      : canConfigure
                        ? t("sourceCard.uploadEmpty")
                        : t("sourceCard.uploadEmptyReadOnly")
              }
            : source.kind === "image"
              ? { icon: Box, title: t("sourceCard.image"), text: t("sourceCard.imageShort") }
              : { icon: Unplug, title: t("sourceCard.none"), text: t("sourceCard.noneShort") };
    const Icon = other.icon;
    return (
        <SettingsCard
            entry="repository"
            title={other.title}
            description={other.text}
            actions={controls}
        >
            {source.kind === "image" && (
                <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span
                        title={source.image}
                        className="min-w-0 flex-1 truncate font-mono text-xs"
                    >
                        {source.image}
                    </span>
                    <CopyButton value={source.image} className="shrink-0" />
                </div>
            )}
        </SettingsCard>
    );
}

/** The Source card, loaded for one service, with its change and disconnect. */
export function SourceRepositoryCard({
    app,
    canConfigure,
    onChanged
}: {
    app: ProjectApp;
    canConfigure: boolean;
    onChanged?: () => void;
}) {
    const t = useTranslations("deployService");
    const [source, setSource] = useState<ServiceSourceView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [changing, setChanging] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        void serviceSourceAction(app.id)
            .then((result) => {
                if (!active) return;
                if (result.source) {
                    setSource(result.source);
                    setError(null);
                } else setError(result.error ?? t("sourceCard.loadFailed"));
            })
            .catch(() => {
                if (active) setError(t("sourceCard.loadFailed"));
            });
        return () => {
            active = false;
        };
        // The branch and root directory follow the service's saved settings.
    }, [app.id, app.deployBranch, app.sourceType, attempt, t]);

    function changed() {
        setAttempt((count) => count + 1);
        onChanged?.();
    }

    function disconnect() {
        setActionError(null);
        startTransition(async () => {
            const result = await disconnectSourceAction(app.id);
            if (result.error) {
                setActionError(result.error);
                return;
            }
            setDisconnecting(false);
            changed();
        });
    }

    if (error && !source) {
        return (
            <CardError
                entry="repository"
                title={t("sourceCard.repository")}
                message={error}
                onRetry={() => setAttempt((count) => count + 1)}
            />
        );
    }
    if (!source) return <CardSkeleton entry="repository" title={t("sourceCard.repository")} />;

    // Only a service built from code has a repository to change or connect.
    const built = app.sourceType === "dockerfile" || app.sourceType === "nixpacks";
    const connected = source.kind === "repository";
    const controls =
        canConfigure && built ? (
            connected ? (
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("sourceCard.change")}
                        title={t("sourceCard.change")}
                        onClick={() => setChanging(true)}
                    >
                        <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setActionError(null);
                            setDisconnecting(true);
                        }}
                    >
                        {t("sourceCard.disconnect")}
                    </Button>
                </div>
            ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setChanging(true)}>
                    {t("sourceCard.connect")}
                </Button>
            )
        ) : undefined;

    return (
        <>
            <SourceRepositoryView
                source={source}
                rootDirectory={app.rootDirectory}
                autoDeploy={app.autoDeploy}
                canConfigure={canConfigure}
                controls={controls}
            />
            {changing ? (
                <ChangeRepositoryDialog
                    applicationId={app.id}
                    connected={connected}
                    onClose={() => setChanging(false)}
                    onDone={() => {
                        setChanging(false);
                        changed();
                    }}
                />
            ) : null}
            {source.kind === "repository" ? (
                <ConfirmDeleteDialog
                    open={disconnecting}
                    onOpenChange={(open) => !open && setDisconnecting(false)}
                    name={source.name}
                    requireTyping={false}
                    kind="repository"
                    title={t("sourceCard.disconnectTitle", { name: source.name })}
                    question={t("sourceCard.disconnectTitle", { name: source.name })}
                    description={t("sourceCard.disconnectText")}
                    confirmLabel={t("sourceCard.disconnect")}
                    error={actionError}
                    pending={pending}
                    onConfirm={disconnect}
                />
            ) : null}
        </>
    );
}

/**
 * Pick the repository (and branch) the service builds from, with the same
 * picker a new service from GitHub uses.
 */
function ChangeRepositoryDialog({
    applicationId,
    connected,
    onClose,
    onDone
}: {
    applicationId: string;
    connected: boolean;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("deployService");
    const [repo, setRepo] = useState<PickerRepo | null>(null);
    const [branch, setBranch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function save() {
        if (!repo) return;
        setError(null);
        startTransition(async () => {
            const result = await changeSourceAction(applicationId, {
                repoFullName: repo.fullName,
                branch: branch.trim()
            });
            if (result.error) setError(result.error);
            else onDone();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {connected ? t("sourceCard.changeTitle") : t("sourceCard.connectTitle")}
                    </DialogTitle>
                    <DialogDescription>{t("sourceCard.changeText")}</DialogDescription>
                </DialogHeader>
                {repo ? (
                    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2">
                        <GitHubMark className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-sm" title={repo.fullName}>
                            {repo.fullName}
                        </span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setRepo(null)}
                        >
                            {t("sourceCard.changePick")}
                        </Button>
                    </div>
                ) : (
                    <RepoPicker
                        cacheKey="deploy"
                        autoFocus
                        list={deployActions.githubReposAction}
                        search={deployActions.searchGithubReposAction}
                        onPick={(picked) => {
                            setRepo(picked);
                            setBranch(picked.defaultBranch);
                        }}
                    />
                )}
                {repo ? (
                    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                        {t("sourceCard.branch")}
                        <Input
                            value={branch}
                            onChange={(event) => setBranch(event.target.value)}
                            placeholder={repo.defaultBranch}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    </label>
                ) : null}
                {error ? <p className="text-xs text-danger-ink">{error}</p> : null}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                        {t("sourceCard.cancel")}
                    </Button>
                    <Button type="button" onClick={save} disabled={!repo || pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {t("sourceCard.changeSave")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
/** What builds the service, as stored: the facts the Builder card states. */
export function builderOf(
    app: Pick<ProjectApp, "sourceType" | "rootDirectory" | "dockerfilePath">
): { kind: "dockerfile"; path: string } | { kind: "auto" | "image" | "other" } {
    if (app.sourceType === "dockerfile") {
        const root = (app.rootDirectory ?? "").trim().replace(/^\/+|\/+$/g, "");
        const file = (app.dockerfilePath ?? "").trim() || "Dockerfile";
        return { kind: "dockerfile", path: root ? `${root}/${file}` : file };
    }
    if (app.sourceType === "nixpacks") return { kind: "auto" };
    if (app.sourceType === "image") return { kind: "image" };
    return { kind: "other" };
}

/** The Builder card: what turns the source into an image, and why that one. */
export function BuilderCard({
    app,
    footer,
    children
}: {
    app: ProjectApp;
    footer?: ReactNode;
    children?: ReactNode;
}) {
    const t = useTranslations("deployService");
    const builder = builderOf(app);
    const [name, why] =
        builder.kind === "dockerfile"
            ? [t("builder.dockerfile"), t("builder.dockerfileShort", { path: builder.path })]
            : builder.kind === "auto"
              ? [t("builder.auto"), t("builder.autoShort")]
              : builder.kind === "image"
                ? [t("builder.image"), t("builder.imageShort")]
                : [t("builder.other"), t("builder.otherShort")];
    return (
        <SettingsCard
            entry="builder"
            title={t("builder.title")}
            description={t("builder.short")}
            footer={footer}
        >
            <div className="flex min-w-0 items-start gap-3 rounded-md border border-border px-3 py-2.5">
                <Hammer className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{name}</span>
                    <span className="break-words text-xs text-muted-foreground">{why}</span>
                </div>
            </div>
            {children}
        </SettingsCard>
    );
}
