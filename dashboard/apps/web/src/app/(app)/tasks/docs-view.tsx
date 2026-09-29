"use client";

/**
 * Docs: a tree of Markdown pages next to the work.
 *
 * The surface is the shared rich-text editor, and what it saves is still
 * Markdown - which was always the point. Somebody's knowledge base can be read,
 * diffed and taken out of Polaris unchanged; what changed is that they no longer
 * have to type the syntax to get the formatting.
 */

import { useState } from "react";
import * as actions from "./actions";
import { cn, Button, EmptyState } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DocNode, DocView } from "@/lib/tasks/doc-service";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { ChevronRight, FileText, Plus, Search, Trash2 } from "lucide-react";

function TreeBranch({
    nodes,
    activeId,
    depth,
    onOpen
}: {
    nodes: readonly DocNode[];
    activeId: string | null;
    depth: number;
    onOpen: (id: string) => void;
}) {
    return (
        <ul className="flex flex-col gap-0.5">
            {nodes.map((node) => (
                <li key={node.id}>
                    <button
                        type="button"
                        onClick={() => onOpen(node.id)}
                        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
                        className={cn(
                            "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-sm transition-colors hover:bg-muted",
                            activeId === node.id ? "bg-muted font-medium" : "text-muted-foreground"
                        )}
                    >
                        {node.children.length > 0 ? (
                            <ChevronRight className="size-3 shrink-0 opacity-60" />
                        ) : (
                            <FileText className="size-3.5 shrink-0 opacity-60" />
                        )}
                        <span className="truncate">
                            {node.icon} {node.title}
                        </span>
                    </button>
                    {node.children.length > 0 && (
                        <TreeBranch
                            nodes={node.children}
                            activeId={activeId}
                            depth={depth + 1}
                            onOpen={onOpen}
                        />
                    )}
                </li>
            ))}
        </ul>
    );
}

export function DocsView({
    tree,
    doc,
    spaces,
    canEdit
}: {
    tree: readonly DocNode[];
    /** The page being read, or null when none is open. */
    doc: DocView | null;
    spaces: readonly { id: string; name: string }[];
    canEdit: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    const [title, setTitle] = useState(doc?.title ?? "");
    const [body, setBody] = useState(doc?.body ?? "");
    const [query, setQuery] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const dirty = doc !== null && (title !== doc.title || body !== doc.body);

    const open = (id: string) => router.push(`/tasks/docs?doc=${id}`);

    const save = async () => {
        if (!doc || !dirty) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.updateDocAction(doc.id, {
                    title: title.trim() || t("docs.untitled"),
                    body,
                    spaceId: doc.spaceId,
                    // Sent back as it was: a save is an edit to the text, and
                    // leaving this out would quietly lift the page out of the
                    // folder it belongs to on every keystroke saved.
                    folderId: doc.folderId,
                    parentId: doc.parentId,
                    icon: doc.icon
                }),
            setError
        );
        if (result?.error) setError(result.error);
        setSaving(false);
        router.refresh();
    };

    const matches = query.trim()
        ? tree.filter((node) => node.title.toLowerCase().includes(query.trim().toLowerCase()))
        : tree;

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <aside className="flex w-full flex-col gap-2 md:w-60 md:shrink-0">
                <div className="flex items-center justify-between">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("docs.pages")}
                    </h2>
                    {canEdit && (
                        <button
                            type="button"
                            aria-label={t("docs.newPage")}
                            title={t("docs.newPage")}
                            onClick={async () => {
                                const result = await runAction(
                                    () =>
                                        actions.createDocAction({
                                            title: t("docs.untitled"),
                                            spaceId: spaces[0]?.id ?? null
                                        }),
                                    setError
                                );
                                if (result?.id) open(result.id);
                                else router.refresh();
                            }}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Plus className="size-3.5" />
                        </button>
                    )}
                </div>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("docs.find")}
                        aria-label={t("docs.find")}
                        className="h-8 w-full rounded-md border border-border bg-field pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                    />
                </div>

                {matches.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("docs.noPages")}</p>
                ) : (
                    <TreeBranch
                        nodes={matches}
                        activeId={doc?.id ?? null}
                        depth={0}
                        onOpen={open}
                    />
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!doc && (
                    <EmptyState
                        title={t("docs.emptyTitle")}
                        description={t("docs.emptyDescription")}
                    />
                )}

                {doc && (
                    <>
                        {doc.breadcrumb.length > 0 && (
                            <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                {doc.breadcrumb.map((crumb) => (
                                    <span key={crumb.id} className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => open(crumb.id)}
                                            className="hover:underline"
                                        >
                                            {crumb.title}
                                        </button>
                                        <ChevronRight className="size-3" />
                                    </span>
                                ))}
                            </nav>
                        )}

                        <input
                            value={title}
                            disabled={!canEdit}
                            aria-label={t("docs.pageTitle")}
                            onChange={(event) => setTitle(event.target.value)}
                            className="w-full bg-transparent text-2xl font-semibold outline-none"
                        />

                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>
                                {doc.updatedByName
                                    ? t.rich("docs.updatedBy", {
                                          name: doc.updatedByName,
                                          time: () => <RelativeTime key="time" iso={doc.updatedAt} />
                                      })
                                    : t.rich("docs.updated", {
                                          time: () => <RelativeTime key="time" iso={doc.updatedAt} />
                                      })}
                            </span>
                            <span className="flex-1" />
                            {canEdit && (
                                <>
                                    <Button
                                        size="sm"
                                        disabled={!dirty || saving}
                                        onClick={() => void save()}
                                    >
                                        {saving ? t("docs.saving") : dirty ? tc("actions.save") : t("docs.saved")}
                                    </Button>
                                    <button
                                        type="button"
                                        aria-label={t("docs.deleteThis")}
                                        title={t("docs.delete")}
                                        onClick={async () => {
                                            await runAction(
                                                () => actions.deleteDocAction(doc.id),
                                                setError
                                            );
                                            router.push("/tasks/docs");
                                        }}
                                        className="rounded p-1 transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </>
                            )}
                        </div>

                        {error && (
                            <p
                                role="alert"
                                className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                            >
                                {error}
                            </p>
                        )}

                        <RichTextEditor
                            // Pointed at another page, the surface has to be
                            // rebuilt: it holds its own document and would keep
                            // showing the last one.
                            key={doc.id}
                            value={body}
                            disabled={!canEdit}
                            placeholder={t("docs.placeholder")}
                            onChange={setBody}
                            // A page earns a taller ceiling than a form field,
                            // but still a ceiling: a surface that grows past the
                            // viewport takes its own save button with it.
                            className="min-h-[24rem] max-h-[70vh] flex-1 overflow-y-auto overscroll-contain"
                        />
                    </>
                )}
            </div>
        </div>
    );
}
