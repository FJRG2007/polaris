"use client";

/**
 * Docs: a tree of Markdown pages next to the work.
 *
 * The editor is a plain textarea over Markdown rather than a block editor. That
 * is a deliberate trade: what somebody writes here can be read, diffed and taken
 * out of Polaris unchanged, and the alternative buys formatting nobody asked for
 * at the cost of owning their content.
 */

import { useState } from "react";
import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { cn, Button, Textarea } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { DocNode, DocView } from "@/lib/tasks/doc-service";
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
                        <TreeBranch nodes={node.children} activeId={activeId} depth={depth + 1} onOpen={onOpen} />
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
                    title: title.trim() || "Untitled",
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
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pages</h2>
                    {canEdit && (
                        <button
                            type="button"
                            aria-label="New page"
                            title="New page"
                            onClick={async () => {
                                const result = await runAction(
                                    () =>
                                        actions.createDocAction({
                                            title: "Untitled",
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
                        placeholder="Find a page"
                        aria-label="Find a page"
                        className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
                    />
                </div>

                {matches.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No pages yet.</p>
                ) : (
                    <TreeBranch nodes={matches} activeId={doc?.id ?? null} depth={0} onOpen={open} />
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!doc && (
                    <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
                        Pick a page, or write a new one. Docs live beside the work rather than in another tool.
                    </p>
                )}

                {doc && (
                    <>
                        {doc.breadcrumb.length > 0 && (
                            <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                {doc.breadcrumb.map((crumb) => (
                                    <span key={crumb.id} className="flex items-center gap-1">
                                        <button type="button" onClick={() => open(crumb.id)} className="hover:underline">
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
                            aria-label="Page title"
                            onChange={(event) => setTitle(event.target.value)}
                            className="w-full bg-transparent text-2xl font-semibold outline-none"
                        />

                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>
                                Updated <RelativeTime iso={doc.updatedAt} />
                                {doc.updatedByName ? ` by ${doc.updatedByName}` : ""}
                            </span>
                            <span className="flex-1" />
                            {canEdit && (
                                <>
                                    <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                                        {saving ? "Saving" : dirty ? "Save" : "Saved"}
                                    </Button>
                                    <button
                                        type="button"
                                        aria-label="Delete this page"
                                        title="Delete page"
                                        onClick={async () => {
                                            await runAction(() => actions.deleteDocAction(doc.id), setError);
                                            router.push("/tasks/docs");
                                        }}
                                        className="rounded p-1 transition-colors hover:bg-muted hover:text-destructive"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </>
                            )}
                        </div>

                        {error && (
                            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                {error}
                            </p>
                        )}

                        <Textarea
                            value={body}
                            rows={24}
                            disabled={!canEdit}
                            aria-label="Page content"
                            placeholder="Write in Markdown. Headings with #, lists with -, links with [text](url)."
                            onChange={(event) => setBody(event.target.value)}
                            // A page editor earns a taller ceiling than a form
                            // field, but still a ceiling: an editor that grows
                            // past the viewport takes its own save button with it.
                            className="min-h-[24rem] w-full max-h-[70vh] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:border-primary"
                        />
                    </>
                )}
            </div>
        </div>
    );
}
