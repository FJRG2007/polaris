"use client";

/**
 * Polar inside the browser extension's side panel. The chat is `PolarChat`
 * itself - the same component `/polar` and the dashboard's side panel draw -
 * so whatever changes there changes here with the next dashboard update.
 *
 * What this adds is the frame's two edges: the page the person allowed, which
 * arrives from the extension by `postMessage` (`lib/polar/embed-bridge.ts`),
 * and links, which open in a tab of their own because the rest of Polaris
 * refuses to be framed.
 */

import { useEffect, useRef, useState } from "react";
import { buttonVariants, cn } from "@polaris/ui";
import * as bridge from "@/lib/polar/embed-bridge";
import type { SiteContext } from "@/lib/polar/shared";
import { PolarChat, usePolar } from "@/components/polar/polar-panel";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PolarAvatar } from "@/components/polar/motion/polar-avatar";

export function PolarEmbed({
    parent,
    chat = null
}: {
    parent: string | null;
    chat?: string | null;
}) {
    const [site, setSite] = useState<SiteContext | null>(null);
    const { ask } = usePolar();
    const askRef = useRef(ask);
    askRef.current = ask;

    useEffect(() => {
        const framed = parent !== null && window.parent !== window;
        function onMessage(event: MessageEvent) {
            if (!framed || event.source !== window.parent || event.origin !== parent) return;
            const page = bridge.pageFrom(event.data);
            if (page !== undefined) return setSite(page);
            // Asked from the extension's right-click menu: into the composer.
            const asked = bridge.askFrom(event.data);
            if (asked) askRef.current(asked.quote ?? "", asked.draft);
        }
        // Coming back to the panel is when a selection made in the tab is new.
        function refresh() {
            if (framed) window.parent.postMessage(bridge.REFRESH_MESSAGE, parent);
        }
        function onClick(event: MouseEvent) {
            if (event.defaultPrevented || event.button !== 0) return;
            const anchor = (event.target as Element | null)?.closest?.("a[href]");
            if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
            if (!bridge.opensOutside(anchor.href, window.location.href)) return;
            event.preventDefault();
            event.stopPropagation();
            window.open(anchor.href, "_blank", "noopener,noreferrer");
        }
        window.addEventListener("message", onMessage);
        window.addEventListener("focus", refresh);
        // Capture, so a router link never gets to move the frame itself.
        window.addEventListener("click", onClick, true);
        refresh();
        return () => {
            window.removeEventListener("message", onMessage);
            window.removeEventListener("focus", refresh);
            window.removeEventListener("click", onClick, true);
        };
    }, [parent]);

    return (
        <div className="flex h-dvh min-h-0 overflow-hidden bg-card">
            <PolarChat fullPage site={parent ? site : undefined} chatScope={chat} />
        </div>
    );
}

/** What the panel shows instead of the chat: signed out, or no Polar here. */
export function EmbedNotice({ kind }: { kind: "signedOut" | "noAccess" }) {
    const t = useTranslations("polar");
    const signedOut = kind === "signedOut";
    return (
        <main className="flex h-dvh items-center justify-center bg-card px-4">
            <div className="flex w-full max-w-sm min-w-0 flex-col items-center gap-3 text-center">
                <PolarAvatar size={56} state={signedOut ? "idle" : "sleeping"} />
                <h1 className="text-base font-semibold text-foreground">
                    {t(signedOut ? "embed.signedOutTitle" : "embed.noAccessTitle")}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t(signedOut ? "embed.signedOutBody" : "embed.noAccessBody")}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <a
                        href={signedOut ? "/oauth/login" : "/"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: "primary", size: "md" }))}
                    >
                        {t(signedOut ? "embed.signIn" : "embed.openPolaris")}
                    </a>
                    {signedOut ? (
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className={cn(buttonVariants({ variant: "ghost", size: "md" }))}
                        >
                            {t("embed.retry")}
                        </button>
                    ) : null}
                </div>
            </div>
        </main>
    );
}
