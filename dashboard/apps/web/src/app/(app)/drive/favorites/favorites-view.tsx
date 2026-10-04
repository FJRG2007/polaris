"use client";

/**
 * The starred list, with what somebody reaches for on it.
 *
 * Every row used to be one link to the folder the item sits in, and nothing
 * else: a starred file could not be opened from here, and a star could only be
 * taken off by going to the item first. Now the name opens the item itself - a
 * folder in the browser, a file in its viewer - a second button shows it in its
 * folder, and the star takes it off the list on the spot, with Undo on the note
 * in case that was a slip.
 */

import Link from "next/link";
import { useState } from "react";
import { setItemFavoriteAction } from "../actions";
import { FolderOpen, Folder, Star } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, buttonVariants, cn, useToast } from "@polaris/ui";

export interface FavoriteRow {
    readonly connectionId: string;
    readonly connectionName: string;
    readonly path: string;
}

/** The last path segment (an item's display name). */
export function baseName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Parent folder of a path, for the link that shows the item in its folder. */
export function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

/** Where the name leads: the item itself, whichever kind it turns out to be. */
export function openHref(row: FavoriteRow): string {
    return `/drive/open?c=${encodeURIComponent(row.connectionId)}&p=${encodeURIComponent(row.path)}`;
}

/** The folder the item sits in. */
export function folderHref(row: FavoriteRow): string {
    const query = new URLSearchParams({ c: row.connectionId });
    const parent = parentOf(row.path);
    if (parent) query.set("p", parent);
    return `/drive?${query.toString()}`;
}

const keyOf = (row: FavoriteRow): string => `${row.connectionId}:${row.path}`;

export function FavoritesView({
    favorites,
    canEdit
}: {
    favorites: readonly FavoriteRow[];
    /** Whether this reader may change stars at all - the same permission the
     *  action checks. Without it the star is shown, not offered. */
    canEdit: boolean;
}) {
    const t = useTranslations("drive");
    const toast = useToast();
    const [rows, setRows] = useState<readonly FavoriteRow[]>(favorites);

    async function unstar(row: FavoriteRow): Promise<void> {
        const at = rows.findIndex((one) => keyOf(one) === keyOf(row));
        // Off the list now; back where it was if the server says no.
        setRows((current) => current.filter((one) => keyOf(one) !== keyOf(row)));
        try {
            await setItemFavoriteAction(row.connectionId, row.path, false);
        } catch {
            setRows((current) => restore(current, row, at));
            toast.show({ title: t("pages.favorites.removeFailed", { name: baseName(row.path) }) });
            return;
        }
        toast.show({
            title: t("pages.favorites.removed", { name: baseName(row.path) }),
            actions: [
                {
                    label: t("pages.favorites.undo"),
                    run: async () => {
                        try {
                            await setItemFavoriteAction(row.connectionId, row.path, true);
                        } catch {
                            return t("pages.favorites.removeFailed", { name: baseName(row.path) });
                        }
                        setRows((current) => restore(current, row, at));
                        return null;
                    }
                }
            ]
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    {t("pages.favorites.empty")}
                </CardBody>
            </Card>
        );
    }

    return (
        <ul className="flex flex-col gap-2">
            {rows.map((row) => {
                const name = baseName(row.path);
                const parent = parentOf(row.path);
                return (
                    <li key={keyOf(row)}>
                        <Card>
                            <CardBody className="flex items-center gap-3">
                                {canEdit ? (
                                    <button
                                        type="button"
                                        aria-label={t("pages.favorites.remove", { name })}
                                        title={t("pages.favorites.remove", { name })}
                                        onClick={() => void unstar(row)}
                                        className="shrink-0 rounded p-1 transition-colors hover:bg-muted"
                                    >
                                        <Star className="size-4 fill-amber-400 text-amber-400" />
                                    </button>
                                ) : (
                                    <Star
                                        aria-hidden
                                        className="m-1 size-4 shrink-0 fill-amber-400 text-amber-400"
                                    />
                                )}
                                <div className="min-w-0 flex-1">
                                    <Link
                                        href={openHref(row)}
                                        className="block truncate text-sm font-medium hover:underline"
                                        title={name}
                                    >
                                        {name}
                                    </Link>
                                    <p
                                        className="flex items-center gap-1 text-xs text-muted-foreground"
                                        title={`${row.connectionName}${parent ? ` / ${parent}` : ""}`}
                                    >
                                        <Folder className="size-3 shrink-0" />
                                        <span className="truncate">
                                            {row.connectionName}
                                            {parent ? ` / ${parent}` : ""}
                                        </span>
                                    </p>
                                </div>
                                <Link
                                    href={folderHref(row)}
                                    aria-label={t("pages.favorites.showInFolder", { name })}
                                    title={t("pages.favorites.showInFolder", { name })}
                                    className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "shrink-0")}
                                >
                                    <FolderOpen className="size-4" />
                                </Link>
                            </CardBody>
                        </Card>
                    </li>
                );
            })}
        </ul>
    );
}

/** A row put back where it was, unless it is already there. */
function restore(current: readonly FavoriteRow[], row: FavoriteRow, at: number): FavoriteRow[] {
    if (current.some((one) => keyOf(one) === keyOf(row))) return [...current];
    const next = [...current];
    next.splice(Math.max(0, Math.min(at, next.length)), 0, row);
    return next;
}
