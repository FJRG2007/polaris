"use client";

/**
 * The operator's screens: the list of status pages at `/status-pages`, and one
 * page's components, checks, incidents and maintenance at `/status-pages/<id>`.
 *
 * The header and the frame draw at once; only the region waiting on data shows
 * a skeleton, and what the last visit read is drawn first from this tab's
 * cache while the server is asked again.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    EmptyState,
    PageHeader,
    Skeleton,
    cn,
    useToast
} from "@polaris/ui";
import { StatusView } from "./status-view";
import { DomainSection } from "./domain-section";
import { readCache, unwrap, useStatusLocale, useStatusT, writeCache } from "./i18n";
import {
    CheckDialog,
    ComponentDialog,
    IncidentDialog,
    MaintenanceDialog,
    PageDialog,
    UpdateDialog
} from "./forms";
import {
    deleteCheckAction,
    deleteComponentAction,
    deleteIncidentAction,
    deleteMaintenanceAction,
    deletePageAction,
    listPagesAction,
    pageDetailAction,
    previewAction
} from "../actions/manage";
import type { PublicStatusPage } from "../lib/public";
import type { CheckView, PageDetail, PageSummary } from "../lib/manage";

const PUBLIC_BASE = "/status";

const NEW_PAGE = { id: null, title: "", slug: "", description: "", published: false };

export function StatusPagesScreen({ pageId }: { pageId: string | null }) {
    return pageId ? <PageEditor pageId={pageId} /> : <PagesList />;
}

function publicUrl(slug: string): string {
    if (typeof window === "undefined") return `${PUBLIC_BASE}/${slug}`;
    return `${window.location.origin}${PUBLIC_BASE}/${slug}`;
}

function PagesList() {
    const t = useStatusT();
    const [pages, setPages] = useState<PageSummary[] | null>(() => readCache("pages"));
    const [failed, setFailed] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const load = useCallback(() => {
        unwrap(() => listPagesAction(), t("errors.generic"))
            .then((answer) => {
                setPages(answer.pages);
                setFailed(null);
                writeCache("pages", answer.pages);
            })
            .catch((caught: Error) => setFailed(caught.message));
    }, [t]);
    useEffect(load, [load]);

    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
            <PageHeader
                title={t("list.title")}
                description={t("list.description")}
                actions={
                    <Button onClick={() => setCreating(true)}>
                        <Plus aria-hidden /> {t("list.new")}
                    </Button>
                }
            />
            {failed && !pages ? (
                <EmptyState
                    title={t("errors.loadFailed")}
                    description={failed}
                    action={
                        <Button variant="outline" onClick={load}>
                            {t("actions.retry")}
                        </Button>
                    }
                />
            ) : pages === null ? (
                <div className="space-y-2" aria-busy>
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-14 w-full" />
                    ))}
                </div>
            ) : pages.length === 0 ? (
                <EmptyState
                    title={t("list.emptyTitle")}
                    description={t("list.emptyBody")}
                    action={<Button onClick={() => setCreating(true)}>{t("list.new")}</Button>}
                />
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                    {pages.map((page) => (
                        <li key={page.id} className="flex items-center gap-3 px-4 py-3">
                            <Link href={`/status-pages/${page.id}`} className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium" title={page.title}>
                                    {page.title}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {PUBLIC_BASE}/{page.slug} -{" "}
                                    {t("list.components", { count: page.components.toString() })}
                                </p>
                            </Link>
                            {page.openIncidents > 0 ? (
                                <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-xs text-danger">
                                    {t("list.openIncidents", {
                                        count: page.openIncidents.toString()
                                    })}
                                </span>
                            ) : null}
                            <span
                                className={cn(
                                    "shrink-0 rounded-full px-2 py-0.5 text-xs",
                                    page.published
                                        ? "bg-success/15 text-success"
                                        : "bg-muted text-muted-foreground"
                                )}
                            >
                                {page.published ? t("page.isPublished") : t("page.isDraft")}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <PageDialog
                open={creating}
                onOpenChange={setCreating}
                initial={NEW_PAGE}
                onSaved={(id) => {
                    window.location.assign(`/status-pages/${id}`);
                }}
            />
        </div>
    );
}

type Pending =
    | { kind: "page" }
    | { kind: "component"; id: string; name: string }
    | { kind: "check"; id: string; name: string }
    | { kind: "incident"; id: string; name: string }
    | { kind: "maintenance"; id: string; name: string };

function PageEditor({ pageId }: { pageId: string }) {
    const t = useStatusT();
    const locale = useStatusLocale();
    const toast = useToast();
    const [page, setPage] = useState<PageDetail | null>(() => readCache(`page:${pageId}`));
    const [failed, setFailed] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [component, setComponent] = useState<{
        id: string | null;
        name: string;
        description: string;
    } | null>(null);
    const [check, setCheck] = useState<{ componentId: string; check: CheckView | null } | null>(
        null
    );
    const [incidentOpen, setIncidentOpen] = useState(false);
    const [updating, setUpdating] = useState<{ id: string; title: string; state: string } | null>(
        null
    );
    const [maintenanceOpen, setMaintenanceOpen] = useState(false);
    const [deleting, setDeleting] = useState<Pending | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const [preview, setPreview] = useState<PublicStatusPage | null>(null);
    const [showPreview, setShowPreview] = useState(false);

    const load = useCallback(() => {
        unwrap(() => pageDetailAction({ id: pageId }), t("errors.generic"))
            .then((answer) => {
                setPage(answer.page);
                setFailed(null);
                writeCache(`page:${pageId}`, answer.page);
            })
            .catch((caught: Error) => setFailed(caught.message));
    }, [pageId, t]);
    useEffect(load, [load]);

    useEffect(() => {
        if (!showPreview || !page) return;
        let live = true;
        unwrap(() => previewAction({ slug: page.slug }), t("errors.generic"))
            .then((answer) => live && setPreview(answer.view))
            .catch(() => live && setPreview(null));
        return () => {
            live = false;
        };
    }, [showPreview, page, t]);

    const componentNames = useMemo(
        () => (page?.components ?? []).map((entry) => ({ id: entry.id, name: entry.name })),
        [page]
    );
    const pageInitial = useMemo(
        () =>
            page
                ? {
                      id: page.id,
                      title: page.title,
                      slug: page.slug,
                      description: page.description,
                      published: page.published
                  }
                : NEW_PAGE,
        [page]
    );

    /** Takes the row off the screen first and puts it back if the server refuses. */
    const confirmDelete = async () => {
        if (!deleting || !page) return;
        const before = page;
        setDeletePending(true);
        try {
            if (deleting.kind === "page") {
                await unwrap(() => deletePageAction({ id: page.id }), t("errors.generic"));
                window.location.assign("/status-pages");
                return;
            }
            const id = deleting.id;
            const optimistic: PageDetail = {
                ...page,
                components: page.components
                    .filter((entry) => !(deleting.kind === "component" && entry.id === id))
                    .map((entry) => ({
                        ...entry,
                        checks: entry.checks.filter((row) => row.id !== id)
                    })),
                incidents: page.incidents.filter((row) => row.id !== id),
                maintenance: page.maintenance.filter((row) => row.id !== id)
            };
            setPage(optimistic);
            setDeleting(null);
            const action = {
                component: deleteComponentAction,
                check: deleteCheckAction,
                incident: deleteIncidentAction,
                maintenance: deleteMaintenanceAction
            }[deleting.kind];
            await unwrap(() => action({ id }), t("errors.generic"));
            writeCache(`page:${pageId}`, optimistic);
        } catch (caught) {
            setPage(before);
            toast.show({ title: t("errors.deleteFailed"), body: (caught as Error).message });
        } finally {
            setDeletePending(false);
        }
    };

    const header = (
        <div className="mb-4 space-y-3">
            <Link
                href="/status-pages"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-3.5" aria-hidden /> {t("list.title")}
            </Link>
            <PageHeader
                title={page?.title ?? t("page.loading")}
                description={page ? `${PUBLIC_BASE}/${page.slug}` : undefined}
                actions={
                    page ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <CopyButton value={publicUrl(page.slug)} />
                            {page.published ? (
                                <Button variant="outline" asChild>
                                    <a
                                        href={`${PUBLIC_BASE}/${page.slug}`}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        <ExternalLink aria-hidden /> {t("page.open")}
                                    </a>
                                </Button>
                            ) : null}
                            <Button
                                variant="outline"
                                onClick={() => setShowPreview((on) => !on)}
                                aria-pressed={showPreview}
                            >
                                <Eye aria-hidden />{" "}
                                {showPreview ? t("page.hidePreview") : t("page.preview")}
                            </Button>
                            <Button
                                variant="outline"
                                size="icon"
                                aria-label={t("page.edit")}
                                title={t("page.edit")}
                                onClick={() => setEditing(true)}
                            >
                                <Pencil aria-hidden />
                            </Button>
                        </div>
                    ) : null
                }
            />
            {page && !page.published ? (
                <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {t("page.draftNotice")}
                </p>
            ) : null}
        </div>
    );

    if (!page) {
        return (
            <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
                {header}
                {failed ? (
                    <EmptyState
                        title={t("errors.loadFailed")}
                        description={failed}
                        action={
                            <Button variant="outline" onClick={load}>
                                {t("actions.retry")}
                            </Button>
                        }
                    />
                ) : (
                    <div className="space-y-2" aria-busy>
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-20 w-full" />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
            {header}

            {showPreview ? (
                <div className="mb-6 rounded-lg border border-border">
                    {preview ? (
                        <StatusView view={preview} t={t} locale={locale} />
                    ) : (
                        <Skeleton className="h-64 w-full" />
                    )}
                </div>
            ) : null}

            <section className="space-y-3" aria-labelledby="sp-components">
                <div className="flex items-center justify-between gap-2">
                    <h2 id="sp-components" className="text-sm font-semibold">
                        {t("component.heading")}
                    </h2>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setComponent({ id: null, name: "", description: "" })}
                    >
                        <Plus aria-hidden /> {t("component.add")}
                    </Button>
                </div>
                {page.components.length === 0 ? (
                    <EmptyState
                        title={t("component.emptyTitle")}
                        description={t("component.emptyBody")}
                    />
                ) : (
                    page.components.map((entry) => (
                        <div key={entry.id} className="rounded-lg border border-border bg-card">
                            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium" title={entry.name}>
                                        {entry.name}
                                    </p>
                                    {entry.description ? (
                                        <p className="truncate text-xs text-muted-foreground">
                                            {entry.description}
                                        </p>
                                    ) : null}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setCheck({ componentId: entry.id, check: null })}
                                >
                                    <Plus aria-hidden /> {t("check.add")}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("component.edit")}
                                    title={t("component.edit")}
                                    onClick={() =>
                                        setComponent({
                                            id: entry.id,
                                            name: entry.name,
                                            description: entry.description
                                        })
                                    }
                                >
                                    <Pencil aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("component.delete")}
                                    title={t("component.delete")}
                                    onClick={() =>
                                        setDeleting({
                                            kind: "component",
                                            id: entry.id,
                                            name: entry.name
                                        })
                                    }
                                >
                                    <Trash2 aria-hidden />
                                </Button>
                            </div>
                            {entry.checks.length === 0 ? (
                                <p className="px-4 py-3 text-xs text-muted-foreground">
                                    {t("check.none")}
                                </p>
                            ) : (
                                <ul className="divide-y divide-border">
                                    {entry.checks.map((row) => (
                                        <li
                                            key={row.id}
                                            className="flex items-center gap-2 px-4 py-2"
                                        >
                                            <span
                                                className={cn(
                                                    "size-2 shrink-0 rounded-full",
                                                    !row.enabled
                                                        ? "bg-muted-foreground/30"
                                                        : row.lastStatus === "up"
                                                          ? "bg-success"
                                                          : row.lastStatus === "down"
                                                            ? "bg-danger"
                                                            : "bg-muted-foreground/40"
                                                )}
                                                aria-hidden
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p
                                                    className="truncate text-xs font-medium"
                                                    title={row.target}
                                                >
                                                    {t(`check.kinds.${row.kind as "http"}`)} -{" "}
                                                    {row.target}
                                                    {row.port ? `:${row.port}` : ""}
                                                </p>
                                                <p className="truncate text-[0.6875rem] text-muted-foreground">
                                                    {checkLine(row, t, locale)}
                                                </p>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                aria-label={t("check.edit")}
                                                title={t("check.edit")}
                                                onClick={() =>
                                                    setCheck({ componentId: entry.id, check: row })
                                                }
                                            >
                                                <Pencil aria-hidden />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                aria-label={t("check.delete")}
                                                title={t("check.delete")}
                                                onClick={() =>
                                                    setDeleting({
                                                        kind: "check",
                                                        id: row.id,
                                                        name: row.target
                                                    })
                                                }
                                            >
                                                <Trash2 aria-hidden />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))
                )}
            </section>

            <section className="mt-8 space-y-3" aria-labelledby="sp-incidents">
                <div className="flex items-center justify-between gap-2">
                    <h2 id="sp-incidents" className="text-sm font-semibold">
                        {t("incident.heading")}
                    </h2>
                    <Button variant="outline" size="sm" onClick={() => setIncidentOpen(true)}>
                        <Plus aria-hidden /> {t("incident.add")}
                    </Button>
                </div>
                {page.incidents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("incident.none")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                        {page.incidents.map((incident) => (
                            <li key={incident.id} className="flex items-start gap-2 px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-sm font-medium"
                                        title={incident.title}
                                    >
                                        {incident.title}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {t(`impact.${incident.impact as "minor"}`)} -{" "}
                                        {t(`incidentState.${incident.state as "resolved"}`)} -{" "}
                                        {new Date(incident.startedAt).toLocaleString(locale, {
                                            dateStyle: "medium",
                                            timeStyle: "short"
                                        })}
                                    </p>
                                    {incident.updates[0] ? (
                                        <p className="mt-1 line-clamp-2 break-words text-xs">
                                            {incident.updates[0].body}
                                        </p>
                                    ) : null}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setUpdating(incident)}
                                >
                                    {incident.state === "resolved"
                                        ? t("incident.reopen")
                                        : t("incident.postUpdate")}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("incident.delete")}
                                    title={t("incident.delete")}
                                    onClick={() =>
                                        setDeleting({
                                            kind: "incident",
                                            id: incident.id,
                                            name: incident.title
                                        })
                                    }
                                >
                                    <Trash2 aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="mt-8 space-y-3" aria-labelledby="sp-maintenance">
                <div className="flex items-center justify-between gap-2">
                    <h2 id="sp-maintenance" className="text-sm font-semibold">
                        {t("maintenance.heading")}
                    </h2>
                    <Button variant="outline" size="sm" onClick={() => setMaintenanceOpen(true)}>
                        <Plus aria-hidden /> {t("maintenance.add")}
                    </Button>
                </div>
                {page.maintenance.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("maintenance.none")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                        {page.maintenance.map((window) => (
                            <li key={window.id} className="flex items-start gap-2 px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-sm font-medium"
                                        title={window.title}
                                    >
                                        {window.title}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {new Date(window.startsAt).toLocaleString(locale, {
                                            dateStyle: "medium",
                                            timeStyle: "short"
                                        })}{" "}
                                        -{" "}
                                        {new Date(window.endsAt).toLocaleString(locale, {
                                            dateStyle: "medium",
                                            timeStyle: "short"
                                        })}
                                    </p>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("maintenance.delete")}
                                    title={t("maintenance.delete")}
                                    onClick={() =>
                                        setDeleting({
                                            kind: "maintenance",
                                            id: window.id,
                                            name: window.title
                                        })
                                    }
                                >
                                    <Trash2 aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <DomainSection
                pageId={page.id}
                domain={page.customDomain}
                published={page.published}
                onChanged={load}
            />

            <section className="mt-10 rounded-lg border border-danger/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("page.deleteTitle")}</p>
                        <p className="text-xs text-muted-foreground">{t("page.deleteBody")}</p>
                    </div>
                    <Button variant="danger" onClick={() => setDeleting({ kind: "page" })}>
                        {t("page.delete")}
                    </Button>
                </div>
            </section>

            <PageDialog
                open={editing}
                onOpenChange={setEditing}
                initial={pageInitial}
                onSaved={load}
            />
            {component ? (
                <ComponentDialog
                    open
                    onOpenChange={(open) => !open && setComponent(null)}
                    pageId={page.id}
                    initial={component}
                    onSaved={load}
                />
            ) : null}
            {check ? (
                <CheckDialog
                    open
                    onOpenChange={(open) => !open && setCheck(null)}
                    componentId={check.componentId}
                    check={check.check}
                    onSaved={load}
                />
            ) : null}
            <IncidentDialog
                open={incidentOpen}
                onOpenChange={setIncidentOpen}
                pageId={page.id}
                components={componentNames}
                onSaved={load}
            />
            <UpdateDialog
                open={updating !== null}
                onOpenChange={(open) => !open && setUpdating(null)}
                incident={updating}
                onSaved={load}
            />
            <MaintenanceDialog
                open={maintenanceOpen}
                onOpenChange={setMaintenanceOpen}
                pageId={page.id}
                components={componentNames}
                onSaved={load}
            />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.kind === "page" ? page.title : (deleting?.name ?? "")}
                requireTyping={deleting?.kind === "page"}
                kind={t(`deleteKind.${deleting?.kind ?? "page"}`)}
                description={deleting?.kind === "page" ? t("page.deleteBody") : undefined}
                pending={deletePending}
                onConfirm={() => void confirmDelete()}
            />
        </div>
    );
}

function checkLine(row: CheckView, t: ReturnType<typeof useStatusT>, locale: string): string {
    if (!row.enabled) return t("check.paused");
    if (!row.lastCheckedAt) return t("check.waiting");
    const at = new Date(row.lastCheckedAt).toLocaleTimeString(locale, { timeStyle: "short" });
    if (row.lastStatus === "up") {
        return t("check.lastUp", { at, ms: (row.lastLatencyMs ?? 0).toString() });
    }
    const reason = row.lastError
        ? t(`checkError.${row.lastError as "timeout"}`)
        : t("checkError.network");
    return t("check.lastDown", { at, reason });
}
