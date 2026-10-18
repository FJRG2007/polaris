/**
 * The filter the address puts on the automations list, as chips: the app, and
 * the thing of it. Each chip is a link to the list without it - removing the
 * app takes the thing with it, since the thing only means something inside it.
 */

import Link from "next/link";
import { X } from "lucide-react";
import { getTranslations } from "@/lib/i18n/request";

interface Chip {
    readonly name: string;
    /** The list without this chip. */
    readonly clear: string;
}

export async function FilterChips({ app, item }: { app: Chip; item: Chip | null }) {
    const t = await getTranslations("automations");
    return (
        <div
            className="mb-4 flex min-w-0 flex-wrap items-center gap-2"
            role="group"
            aria-label={t("filter.label")}
        >
            <span className="text-xs text-muted-foreground">{t("filter.label")}</span>
            {[app, ...(item ? [item] : [])].map((chip) => (
                <Link
                    key={chip.clear}
                    href={chip.clear}
                    className="inline-flex min-w-0 max-w-[16rem] items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted/70"
                    aria-label={t("filter.remove", { name: chip.name })}
                    title={t("filter.remove", { name: chip.name })}
                >
                    <span className="truncate">{chip.name}</span>
                    <X className="size-3 shrink-0" aria-hidden="true" />
                </Link>
            ))}
        </div>
    );
}
