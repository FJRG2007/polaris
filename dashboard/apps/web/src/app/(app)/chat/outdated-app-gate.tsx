"use client";

/**
 * The composer, or - inside a Polaris app too old for sealed chat - the line
 * that says to update it (docs/chat-e2ee-mls.md, "Client readiness").
 *
 * The delivery route already refuses such an app (`sealedAppOutdated` in
 * `mls-handler.ts`, 426), so nothing it typed could be sent or opened; this
 * says so before anything is typed, with the button to the app's own update
 * screen, rather than leaving every message stuck as "not sent". Only while
 * sealed chat is on: with it off an old app chats as it always did.
 *
 * Read after the first paint, from the page's own agent, so the server's
 * render and the first client render agree.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { useEffect, useState, type ReactNode } from "react";
import { sealedChatActive } from "@/lib/chat/e2ee/sealed-chat";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { sealedAppOutdated, type OutdatedApp } from "@/lib/chat/e2ee/client-version";

/** Where every Polaris app checks for and installs its own update. */
export const APP_UPDATE_PATH = "/account/app/general";

export function OutdatedAppGate({ children }: { children: ReactNode }) {
    const t = useTranslations("chat");
    const [outdated, setOutdated] = useState<OutdatedApp | null>(null);
    useEffect(() => setOutdated(sealedAppOutdated(navigator.userAgent)), []);

    if (!outdated || !sealedChatActive()) return <>{children}</>;
    return (
        <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3"
        >
            <p className="min-w-0 text-xs text-muted-foreground">{t("channelView.updateAppToChat")}</p>
            <Button asChild size="sm">
                <Link href={APP_UPDATE_PATH}>{t("channelView.updateApp")}</Link>
            </Button>
        </div>
    );
}
