"use client";

/**
 * The "Who" of one access-log row on a shared link: the visitor's face and name
 * when they were signed in to Polaris, "Anonymous" when they were not. The name
 * opens the account's profile, where that account's own privacy decides what
 * the reader is shown next.
 */

import Link from "next/link";
import { Avatar } from "@/components/avatar";
import type { LinkVisitor } from "@/lib/link-visitor";
import { countryName } from "@/components/map/country-name";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

export function LinkVisitorCell({ visitor }: { visitor: LinkVisitor | null }) {
    const t = useTranslations("drive");
    if (!visitor) {
        return <span className="text-muted-foreground">{t("linkVisitor.anonymous")}</span>;
    }
    return (
        <span className="flex max-w-48 min-w-0 items-center gap-1.5">
            <Avatar person={{ id: visitor.id, name: visitor.name }} size={20} status={false} />
            {visitor.username ? (
                <Link
                    href={`/u/${encodeURIComponent(visitor.username)}`}
                    title={t("linkVisitor.openProfile", { name: visitor.name })}
                    className="min-w-0 truncate text-primary underline-offset-2 hover:underline"
                >
                    {visitor.name}
                </Link>
            ) : (
                <span className="min-w-0 truncate" title={visitor.name}>
                    {visitor.name}
                </span>
            )}
        </span>
    );
}

/**
 * Where one visit came from, as `visitOrigin` allows it: the address and the
 * country of an anonymous visitor, and nothing for a signed-in one - they are
 * named in the "Who" column, and their address is theirs.
 */
export function VisitOriginCell({
    ip,
    country,
    signedIn
}: {
    ip: string | null;
    country: string | null;
    signedIn: boolean;
}) {
    const t = useTranslations("drive");
    const locale = useLocale();
    if (signedIn) {
        return (
            <span className="text-muted-foreground" title={t("linkVisitor.privateHint")}>
                {t("linkVisitor.private")}
            </span>
        );
    }
    const where = country ? countryName(country, locale) : null;
    return (
        <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono" title={ip ?? undefined}>
                {ip ?? "-"}
            </span>
            {where ? <span className="truncate text-muted-foreground">{where}</span> : null}
        </span>
    );
}

/** How many different accounts appear in a log - the signed-in half of
 *  "unique IPs". */
export function signedInVisitors(rows: readonly { visitor: LinkVisitor | null }[]): number {
    return new Set(rows.map((row) => row.visitor?.id).filter(Boolean)).size;
}
