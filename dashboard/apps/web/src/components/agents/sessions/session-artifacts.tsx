"use client";

/**
 * A Polar Code session's deliverables: the list beside the thread, and the
 * viewer that draws one at any of its versions - Markdown rendered, an HTML
 * page in a frame with no access to this origin, a picture, code highlighted.
 *
 * The bytes always come from a route that serves them under a sandboxing
 * content policy (`lib/agents/artifacts/serve-artifact.ts`), so the frame's
 * own `sandbox` is the second lock, not the only one.
 */

import * as ui from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import { languageForFile } from "@/lib/code-language";
import { CodeSurface } from "@/components/code-surface";
import { useCallback, useEffect, useState } from "react";
import { ShareDialog } from "@/components/access/share-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as polls from "@/components/agents/sessions/sessions-polls";
import { renderMarkdown } from "@/app/(app)/drive/viewer/markdown-render";
import { MarkdownContent } from "@/app/(app)/drive/viewer/markdown-content";
import { Download, FileText, Package, RefreshCw, Share2 } from "lucide-react";
import type { ArtifactVersionView, ArtifactView } from "@/lib/agents/session-artifacts";

/** No `allow-same-origin`: the page gets an opaque origin, never this one. */
const ARTIFACT_FRAME_SANDBOX = "allow-scripts allow-popups";
/** Text drawn at most; a longer file is offered as a download. */
const TEXT_LIMIT = 1024 * 1024;

/** Where one version's bytes are read from. */
export type ArtifactSource = (version: number, download?: boolean) => string;

export function ownArtifactSource(artifactId: string): ArtifactSource {
    return (version, download) =>
        `/api/agents/artifacts/${artifactId}?v=${version}${download ? "&download=1" : ""}`;
}

export function linkArtifactSource(token: string): ArtifactSource {
    return (version, download) =>
        `/api/agents/artifacts/link/${encodeURIComponent(token)}?v=${version}${download ? "&download=1" : ""}`;
}

/** The Artifacts pane of a session's workspace. */
export function SessionArtifacts({ sessionId, live }: { sessionId: string; live: boolean }) {
    const t = useTranslations("polar");
    const [list, setList] = useState<ArtifactView[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [picked, setPicked] = useState<string | null>(null);

    const read = useCallback(
        (capture: boolean, signal?: AbortSignal) => {
            if (capture) setCapturing(true);
            polls
                .sessionArtifacts(sessionId, capture, signal)
                .then((result) => {
                    if (!result?.artifacts) {
                        setFailed(true);
                        return;
                    }
                    setFailed(false);
                    setList(result.artifacts);
                    const answer = result.capture;
                    if (answer?.kind === "captured" && answer.full) setNotice(t("code.artifacts.full"));
                    else if (answer?.kind === "captured" && answer.tooLarge > 0)
                        setNotice(t("code.artifacts.tooLarge", { count: answer.tooLarge }));
                    else if (answer?.kind === "captured" && answer.truncated) setNotice(t("code.artifacts.truncated"));
                    else if (answer) setNotice(null);
                })
                .catch(() => setFailed(true))
                .finally(() => {
                    if (capture) setCapturing(false);
                });
        },
        [sessionId, t]
    );

    // What was captured before draws at once; the capture refreshes it after.
    useEffect(() => {
        const controller = new AbortController();
        read(false, controller.signal);
        if (live) read(true, controller.signal);
        return () => controller.abort();
    }, [read, live]);

    const current = list?.find((entry) => entry.id === picked) ?? null;

    return (
        <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
            <div className="flex min-h-0 w-full shrink-0 flex-col gap-2 md:w-72">
                <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs text-muted-foreground" title={t("code.artifacts.hint")}>
                        {t("code.artifacts.hint")}
                    </p>
                    {live ? (
                        <ui.Button
                            variant="ghost"
                            size="icon"
                            onClick={() => read(true)}
                            disabled={capturing}
                            aria-label={t("code.artifacts.capture")}
                            title={t("code.artifacts.capture")}
                        >
                            <RefreshCw className={ui.cn("size-4", capturing && "animate-spin")} />
                        </ui.Button>
                    ) : null}
                </div>
                {notice ? (
                    <p role="status" className="text-xs text-muted-foreground">
                        {notice}
                    </p>
                ) : null}
                <div className="max-h-48 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border md:max-h-none">
                    {list === null ? (
                        failed ? (
                            <p role="alert" className="p-3 text-sm text-muted-foreground">
                                {t("code.artifacts.failed")}
                            </p>
                        ) : (
                            <div className="space-y-1.5 p-2" aria-busy>
                                {[0, 1, 2].map((key) => (
                                    <ui.Skeleton key={key} className="h-8 w-full" />
                                ))}
                            </div>
                        )
                    ) : list.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">{t("code.artifacts.empty")}</p>
                    ) : (
                        <ul className="py-1">
                            {list.map((entry) => (
                                <li key={entry.id}>
                                    <button
                                        type="button"
                                        onClick={() => setPicked(entry.id)}
                                        title={entry.bundle?.path ?? entry.path}
                                        className={ui.cn(
                                            "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-start text-xs hover:bg-card-hover",
                                            picked === entry.id && "bg-card-hover font-medium"
                                        )}
                                    >
                                        {entry.bundle ? (
                                            <Package className="size-4 shrink-0 text-muted-foreground" />
                                        ) : (
                                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span className={ui.cn("truncate", entry.removed && "line-through")}>
                                                {entry.name}
                                            </span>
                                            <span className="truncate text-muted-foreground">
                                                {t("code.artifacts.meta", {
                                                    version: entry.version,
                                                    size: formatBytes(entry.size)
                                                })}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-border">
                {current ? (
                    <OwnArtifact key={`${current.id}:${current.version}`} artifactId={current.id} />
                ) : (
                    <ui.EmptyState icon={<FileText className="size-5" />} title={t("code.artifacts.pick")} />
                )}
            </div>
        </div>
    );
}

/** One artifact read as its session's reader, with its versions and Share. */
export function OwnArtifact({ artifactId }: { artifactId: string }) {
    const t = useTranslations("polar");
    const [detail, setDetail] = useState<{ artifact: ArtifactView; versions: ArtifactVersionView[] } | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        polls
            .sessionArtifact(artifactId, controller.signal)
            .then((result) => {
                if (result?.detail) setDetail(result.detail);
                else setFailed(true);
            })
            .catch(() => setFailed(true));
        return () => controller.abort();
    }, [artifactId]);

    if (detail) {
        return (
            <ArtifactViewer
                artifact={detail.artifact}
                versions={detail.versions}
                source={ownArtifactSource(artifactId)}
                shareable
            />
        );
    }
    if (failed) return <ui.EmptyState icon={<FileText className="size-5" />} title={t("code.artifacts.failed")} />;
    return <ViewerSkeleton />;
}

function ViewerSkeleton() {
    return (
        <div className="space-y-2 p-3" aria-busy>
            {[0, 1, 2, 3, 4].map((key) => (
                <ui.Skeleton key={key} className="h-4 w-full" />
            ))}
        </div>
    );
}

/** The viewer: a header with the version picker, then the file drawn. */
export function ArtifactViewer({
    artifact,
    versions,
    source,
    shareable = false
}: {
    artifact: ArtifactView;
    versions: readonly ArtifactVersionView[];
    source: ArtifactSource;
    shareable?: boolean;
}) {
    const t = useTranslations("polar");
    const [version, setVersion] = useState(artifact.version);
    const [sharing, setSharing] = useState(false);
    const shown = versions.find((entry) => entry.version === version);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-xs" title={artifact.path}>
                    {artifact.path}
                </p>
                {versions.length > 1 ? (
                    <ui.Select
                        className="h-8 w-44"
                        aria-label={t("code.artifacts.version")}
                        value={String(version)}
                        onValueChange={(next) => setVersion(Number(next))}
                        options={versions.map((entry) => ({
                            value: String(entry.version),
                            label: t("code.artifacts.versionLabel", {
                                version: entry.version,
                                when: new Date(entry.createdAt).toLocaleString()
                            })
                        }))}
                    />
                ) : null}
                <ui.Button asChild variant="ghost" size="icon" title={t("code.artifacts.download")}>
                    <a href={source(version, true)} aria-label={t("code.artifacts.download")} download>
                        <Download className="size-4" />
                    </a>
                </ui.Button>
                {shareable ? (
                    <ui.Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setSharing(true)}
                        aria-label={t("code.artifacts.share")}
                        title={t("code.artifacts.share")}
                    >
                        <Share2 className="size-4" />
                    </ui.Button>
                ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                <ArtifactBody
                    key={version}
                    artifact={artifact}
                    size={shown?.size ?? artifact.size}
                    url={source(version)}
                    download={source(version, true)}
                />
            </div>
            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={setSharing}
                    subject="agents.artifact"
                    subjectId={artifact.id}
                    name={artifact.name}
                />
            ) : null}
        </div>
    );
}

function ArtifactBody({
    artifact,
    size,
    url,
    download
}: {
    artifact: ArtifactView;
    size: number;
    url: string;
    download: string;
}) {
    const t = useTranslations("polar");
    const textual = artifact.kind === "markdown" || artifact.kind === "text";
    const [text, setText] = useState<string | null>(null);
    const [html, setHtml] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const tooLarge = textual && size > TEXT_LIMIT;

    useEffect(() => {
        if (!textual || tooLarge) return;
        const controller = new AbortController();
        fetch(url, { signal: controller.signal, credentials: "same-origin" })
            .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
            .then(async (body) => {
                setText(body);
                if (artifact.kind === "markdown") setHtml(await renderMarkdown(body));
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    console.error("artifact read failed", error);
                    setFailed(true);
                }
            });
        return () => controller.abort();
    }, [url, textual, tooLarge, artifact.kind]);

    if (artifact.kind === "html") {
        return (
            <iframe
                src={url}
                title={artifact.name}
                sandbox={ARTIFACT_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                className="h-full min-h-96 w-full bg-white"
            />
        );
    }
    if (artifact.kind === "image") {
        return (
            <div className="flex min-h-full items-center justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- bytes from a sandboxed route, sized by the file */}
                <img src={url} alt={artifact.name} className="max-h-full max-w-full object-contain" />
            </div>
        );
    }
    if (artifact.kind === "binary" || tooLarge || failed) {
        return (
            <ui.EmptyState
                icon={<FileText className="size-5" />}
                title={failed ? t("code.artifacts.failed") : t("code.artifacts.noPreview")}
                description={formatBytes(size)}
                action={
                    <ui.Button asChild variant="outline" size="sm">
                        <a href={download} download>
                            <Download className="size-4" />
                            {t("code.artifacts.download")}
                        </a>
                    </ui.Button>
                }
            />
        );
    }
    if (artifact.kind === "markdown" && html !== null) {
        return <MarkdownContent html={html} className="p-4" />;
    }
    if (artifact.kind === "text" && text !== null) {
        return (
            <CodeSurface
                code={text}
                language={languageForFile(artifact.name)?.id ?? null}
                ariaLabel={artifact.path}
                readOnly
            />
        );
    }
    return <ViewerSkeleton />;
}
