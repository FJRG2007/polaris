"use client";

/**
 * The line a Deploy template carries when one of Polaris's own apps already does
 * its job: Vaultwarden beside Vault, Uptime Kuma beside Watch.
 *
 * Deploying the template still works - somebody migrating an existing install
 * may want exactly that - so this is a note, not a replacement for the button.
 * What it says is read off `builtInAlternative`, so it can only name a built-in
 * that the replaces table already says does the job.
 *
 * The link is drawn only for a reader who may open that app (`openable`, worked
 * out on the server with the check the app's own pages make); anyone else is
 * still told it exists rather than sent to a screen that turns them away.
 */

import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { AppManifest } from "@/lib/apps/catalog";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { builtInAlternative } from "@/lib/apps/marketplace-store";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BuiltInAlternativeNote({
    app,
    openable
}: {
    app: AppManifest;
    /** Ids of the built-in apps this reader may open. */
    openable: ReadonlySet<string>;
}) {
    const t = useTranslations("marketplace");
    const navLabel = useNavLabel();
    const builtIn = builtInAlternative(app);
    if (!builtIn) return null;
    const name = navLabel(builtIn.label);
    return (
        <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="mt-px size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0">
                {t("card.builtIn", { app: name })}{" "}
                {openable.has(builtIn.id) && (
                    <Link
                        href={builtIn.href}
                        className="font-medium text-foreground underline underline-offset-2"
                    >
                        {t("card.builtInOpen", { app: name })}
                    </Link>
                )}
            </span>
        </p>
    );
}
