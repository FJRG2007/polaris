"use client";

/**
 * A shared Polar chat, read-only, for anyone holding the link. Its files are
 * read through the link too, so they stop with it.
 */

import { PublicShell } from "@/components/public-shell";
import type { SharedPolarThread } from "@/lib/polar/shared";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SharedMessages } from "@/components/polar/shared-transcript";

export function SharedChat({
    thread,
    token,
    signedIn
}: {
    thread: SharedPolarThread;
    token: string;
    signedIn: boolean;
}) {
    const t = useTranslations("publicPages");
    const date = new Date(thread.sharedAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    return (
        <PublicShell signedIn={signedIn} className="max-w-3xl">
            <header className="min-w-0 space-y-1">
                <h1 className="break-words text-xl font-semibold text-foreground">
                    {thread.title}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t("polarShare.sharedOn", { date })}
                </p>
            </header>
            <SharedMessages
                messages={thread.messages}
                fileUrl={(id) => `/c/${encodeURIComponent(token)}/files/${id}`}
            />
            <p className="text-xs text-foreground-subtle">{t("polarShare.readOnly")}</p>
        </PublicShell>
    );
}
