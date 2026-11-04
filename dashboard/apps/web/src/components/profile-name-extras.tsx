"use client";

/**
 * What sits beside a person's name wherever a profile renders: their name tag
 * and their visible badges, so every profile surface shows the same thing in
 * the same order.
 *
 * `PersonNameTag` (components/name-tags) is the part every drawn name carries - `PersonName` renders it
 * right after the name, so chat, member lists, mentions, task assignees and
 * comments all get it from here. It asks for the tag in a batch with every other
 * name on screen.
 *
 * On the owner's own profile it also opens "Your badges".
 */

import { useState } from "react";
import { Award } from "lucide-react";
import type * as core from "@polaris/core";
import { Button } from "@polaris/ui";
import type { BadgesForViewer } from "@/lib/badges/badge-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BadgesDialog, BadgeStrip } from "@/components/badges/badges-dialog";
import { NameTagButton } from "@/components/name-tags/name-tag-chip";

export function ProfileNameExtras({
    badges,
    own,
    personId,
    tag
}: {
    badges: BadgesForViewer;
    own: boolean;
    /** Whose profile it is, for the tag's card. */
    personId?: string;
    /** The tag, decided on the server for this viewer. */
    tag?: core.NameTagView | null;
}) {
    const t = useTranslations("badges");
    const [open, setOpen] = useState(false);
    const hidden = (badges.arrangement ?? []).filter((row) => row.hidden).map((row) => row.badge);
    const visible = own
        ? badges.shown.filter((badge) => !hidden.includes(badge.key))
        : badges.shown;
    const worn = tag && personId ? tag : null;
    if (!own && visible.length === 0 && !worn) return null;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            {worn && personId && <NameTagButton tag={worn} personId={personId} />}
            <BadgeStrip badges={visible} />
            {own && (
                <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                    <Award className="size-4 shrink-0" />
                    {t("yourBadges")}
                </Button>
            )}
            {open && (
                <BadgesDialog
                    shown={badges.shown}
                    available={badges.available}
                    hidden={hidden}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}
