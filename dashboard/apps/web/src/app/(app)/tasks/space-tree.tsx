"use client";

/**
 * The spaces sidebar: every space, folder and list the reader can reach.
 *
 * This is the map of the whole app, so it is present on every task screen rather
 * than only on a "spaces" page - moving between two lists should be one click,
 * not a trip back to an index. Folders remember whether they were open, because
 * a tree that resets itself on every navigation is a tree nobody uses twice.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import { runAction } from "@/lib/run-action";
import { usePathname } from "next/navigation";
import { Button, Input, cn } from "@polaris/ui";
import type { SpaceTreeView } from "@/lib/tasks/space-service";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Hash, Plus, Settings2 } from "lucide-react";

export function SpaceTree({ spaces, canCreate }: { spaces: readonly SpaceTreeView[]; canCreate: boolean }) {
    const pathname = usePathname();
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [creatingIn, setCreatingIn] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [newSpace, setNewSpace] = useState(false);
    const [error, setError] = useState("");

    const toggle = (key: string) => {
        const next = new Set(collapsed);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setCollapsed(next);
    };

    const listLink = (list: { id: string; name: string; openCount: number }) => (
        <li key={list.id}>
            <Link
                href={`/tasks/l/${list.id}`}
                className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted",
                    pathname === `/tasks/l/${list.id}` ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                )}
            >
                <Hash className="size-3.5 shrink-0 opacity-60" />
                <span className="flex-1 truncate">{list.name}</span>
                {list.openCount > 0 && <span className="text-[11px] opacity-70">{list.openCount}</span>}
            </Link>
        </li>
    );

    return (
        <nav aria-label="Spaces" className="flex w-full flex-col gap-3 md:w-56 md:shrink-0">
            <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Spaces</h2>
                {canCreate && (
                    <button
                        type="button"
                        aria-label="Create a space"
                        title="Create a space"
                        onClick={() => setNewSpace(!newSpace)}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-3.5" />
                    </button>
                )}
            </div>

            {newSpace && (
                <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                    <Input
                        autoFocus
                        value={draft}
                        placeholder="Space name"
                        onChange={(event) => setDraft(event.target.value)}
                        className="h-8 text-sm"
                    />
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            disabled={!draft.trim()}
                            onClick={async () => {
                                setError("");
                                const result = await runAction(
                                    () => actions.createSpaceAction({ name: draft.trim() }),
                                    setError
                                );
                                if (result?.error) setError(result.error);
                                else {
                                    setDraft("");
                                    setNewSpace(false);
                                }
                            }}
                        >
                            Create
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNewSpace(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            {spaces.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    No spaces yet. A space holds the lists one team works out of.
                </p>
            )}

            {spaces.map((space) => {
                const spaceCollapsed = collapsed.has(space.id);
                const canManage = space.role === "owner" || space.role === "admin" || space.role === "member";
                return (
                    <section key={space.id} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => toggle(space.id)}
                                aria-label={spaceCollapsed ? `Expand ${space.name}` : `Collapse ${space.name}`}
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {spaceCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                            </button>
                            <span
                                aria-hidden
                                className="size-2.5 shrink-0 rounded-sm"
                                style={{ backgroundColor: space.color }}
                            />
                            <Link href={`/tasks/s/${space.id}`} className="flex-1 truncate text-sm font-medium hover:underline">
                                {space.name}
                            </Link>
                            <span className="font-mono text-[10px] text-muted-foreground">{space.prefix}</span>
                            {canManage && (
                                <Link
                                    href={`/tasks/s/${space.id}`}
                                    aria-label={`${space.name} settings`}
                                    title="Space settings"
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <Settings2 className="size-3.5" />
                                </Link>
                            )}
                        </div>

                        {!spaceCollapsed && (
                            <div className="ml-4 flex flex-col gap-0.5">
                                {space.folders.map((folder) => {
                                    const folderKey = `${space.id}:${folder.id}`;
                                    const folderCollapsed = collapsed.has(folderKey);
                                    return (
                                        <div key={folder.id}>
                                            <button
                                                type="button"
                                                onClick={() => toggle(folderKey)}
                                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted"
                                            >
                                                {folderCollapsed ? (
                                                    <ChevronRight className="size-3.5" />
                                                ) : (
                                                    <ChevronDown className="size-3.5" />
                                                )}
                                                <Folder className="size-3.5 opacity-60" />
                                                <span className="flex-1 truncate text-left">{folder.name}</span>
                                            </button>
                                            {!folderCollapsed && (
                                                <ul className="ml-4 flex flex-col gap-0.5">
                                                    {folder.lists.map(listLink)}
                                                </ul>
                                            )}
                                        </div>
                                    );
                                })}

                                <ul className="flex flex-col gap-0.5">{space.lists.map(listLink)}</ul>

                                {canManage && (
                                    <>
                                        {creatingIn === space.id ? (
                                            <Input
                                                autoFocus
                                                value={draft}
                                                placeholder="List name, then enter"
                                                onChange={(event) => setDraft(event.target.value)}
                                                onBlur={() => setCreatingIn(null)}
                                                onKeyDown={async (event) => {
                                                    if (event.key === "Escape") setCreatingIn(null);
                                                    if (event.key === "Enter" && draft.trim()) {
                                                        const result = await runAction(
                                                            () =>
                                                                actions.createListAction({
                                                                    spaceId: space.id,
                                                                    name: draft.trim()
                                                                }),
                                                            setError
                                                        );
                                                        if (result?.error) setError(result.error);
                                                        setDraft("");
                                                        setCreatingIn(null);
                                                    }
                                                }}
                                                className="mt-1 h-7 text-sm"
                                            />
                                        ) : (
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setCreatingIn(space.id);
                                                        setDraft("");
                                                    }}
                                                    className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                >
                                                    <Plus className="size-3.5" /> List
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-label={`Add a folder to ${space.name}`}
                                                    title="Add a folder"
                                                    onClick={async () => {
                                                        const result = await runAction(
                                                            () => actions.createFolderAction(space.id, "New folder"),
                                                            setError
                                                        );
                                                        if (result?.error) setError(result.error);
                                                    }}
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                >
                                                    <FolderPlus className="size-3.5" />
                                                </button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </section>
                );
            })}
        </nav>
    );
}
