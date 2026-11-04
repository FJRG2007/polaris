"use client";

/**
 * What sits beside a person's name wherever a profile renders: their visible
 * badges today, and the one place later additions (organization tags) join
 * them, so every profile surface shows the same thing in the same order.
 *
 * On the owner's own profile it also opens "Your badges".
 */

import { useState } from "react";
import { Award } from "lucide-react";
import { Button } from "@polaris/ui";
import type { BadgesForViewer } from "@/lib/badges/badge-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BadgesDialog, BadgeStrip } from "@/components/badges/badges-dialog";

export function ProfileNameExtras({ badges, own }: { badges: BadgesForViewer; own: boolean }) {
    const t = useTranslations("badges");
    const [open, setOpen] = useState(false);
    const hidden = (badges.arrangement ?? []).filter((row) => row.hidden).map((row) => row.badge);
    const visible = own ? badges.shown.filter((badge) => !hidden.includes(badge.key)) : badges.shown;
    if (!own && visible.length === 0) return null;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
