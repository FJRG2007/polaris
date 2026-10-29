"use client";

/**
 * The links that already exist for the item being shared, above the form that
 * makes a new one - so a second link is a choice rather than an accident.
 *
 * The rows are the shared-links page's own (`SharedView`): the same copy,
 * settings, visits and revoke, and the same owner-only scope. A link someone
 * else made for this item is theirs, and not listed here.
 */

import { Skeleton } from "@polaris/ui";
import { useEffect, useState } from "react";
import { itemLinksAction } from "./share-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SharedView, type ShareRow } from "./shared-links/shared-links-view";

export function ItemLinks({
    connectionId,
    path,
    revision
}: {
    readonly connectionId: string;
    readonly path: string;
    /** Bumped when the dialog made a link, so the list is read again. */
    readonly revision: number;
}) {
    const t = useTranslations("drive");
    const [links, setLinks] = useState<ShareRow[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        setFailed(false);
        itemLinksAction({ connectionId, path }).then(
            (result) => {
                if (live) setLinks(result.links);
            },
            () => {
                if (live) setFailed(true);
            }
        );
        return () => {
            live = false;
        };
    }, [connectionId, path, revision]);

    return (
        <section className="flex flex-col gap-2" aria-label={t("share.existing.title")}>
            <h3 className="text-sm font-medium">{t("share.existing.title")}</h3>
            {failed ? (
                <p className="text-sm text-muted-foreground">{t("share.existing.failed")}</p>
            ) : links === null ? (
                <Skeleton className="h-16 w-full" />
            ) : links.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("share.existing.none")}</p>
            ) : (
                <div className="max-h-72 overflow-auto overscroll-contain">
                    {/* Keyed by what was read: the view keeps its own copy of the
                        rows for its optimistic edits. */}
                    <SharedView
                        key={`${revision}:${links.map((link) => link.id).join(",")}`}
                        shares={links}
                    />
                </div>
            )}
        </section>
    );
}
