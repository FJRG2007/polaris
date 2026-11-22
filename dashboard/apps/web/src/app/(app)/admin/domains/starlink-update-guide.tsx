"use client";

/**
 * On a Starlink line: how to keep its update restarts out of the hours people use.
 *
 * The dish and the Starlink router each drop the line for about a minute to install
 * an update. The dish takes its update window only from the Starlink app - a write
 * from the local network is refused - so this is said as steps with the hour to pick,
 * the one this deployment is least used, in the reader's own time. The app offers
 * four six-hour blocks (overnight, morning, afternoon, evening) and nothing else.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BackupView } from "@/lib/backup-access/service";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";

const STEPS = ["open", "window"] as const;

export function StarlinkUpdateGuide({ view }: { view: BackupView }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const [open, setOpen] = useState(false);
    if (!view.starlinkQuietAt) return null;
    const time = format.time(view.starlinkQuietAt);

    return (
        <div className="flex flex-col gap-2 text-xs">
            <p className="break-words text-muted-foreground">
                {t("domains.backup.starlink.title")} {t("domains.backup.starlink.why")}
            </p>
            <button
                type="button"
                aria-expanded={open}
                className="flex w-fit items-center gap-1 font-medium text-foreground hover:underline"
                onClick={() => setOpen(!open)}
            >
                <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
                {open ? t("domains.backup.starlink.hide") : t("domains.backup.starlink.show")}
            </button>
            {open ? (
                <ol className="flex list-decimal flex-col gap-1 ps-5 text-muted-foreground">
                    {STEPS.map((step) => (
                        <li key={step} className="break-words">
                            {t(`domains.backup.starlink.steps.${step}`, { time })}
                        </li>
                    ))}
                </ol>
            ) : null}
        </div>
    );
}
