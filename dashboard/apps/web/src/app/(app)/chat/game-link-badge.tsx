"use client";

/**
 * The mark on a conversation a game server is linked to (`lib/chat/game-links`):
 * the game's logo beside its name in the rail, and a chip in the header naming
 * the server - a link to its page for somebody who may open it, and only words
 * for everybody else. In a sealed conversation a server that shows it in the
 * game is also named among its members, since the game bridge reads it.
 */

import Link from "next/link";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { cn } from "@polaris/ui";
import { Gamepad2 } from "lucide-react";
import type { ChatGameLinkView } from "@/lib/chat/game-links";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";

/** What a link is called in a sentence: "the Minecraft server Survival". */
export function gameLinkLabel(links: readonly ChatGameLinkView[], t: NamespaceTranslator<"chat">): string {
    const named = links.map((link) => t("gameLink.server", { game: link.game, name: link.name }));
    return t("gameLink.linkedTo", { servers: named.join(t("gameLink.and")) });
}

function Mark({ link, className }: { link: ChatGameLinkView; className?: string }) {
    // object-contain: the game's own file, which is not necessarily square.
    return link.logo ? (
        <img src={link.logo} alt="" className={cn("shrink-0 object-contain", className)} />
    ) : (
        <Gamepad2 className={cn("shrink-0", className)} aria-hidden="true" />
    );
}

/** The rail's: one mark, with the whole sentence on hover and for a reader. */
export function GameLinkMark({ links }: { links: readonly ChatGameLinkView[] }) {
    const t = useTranslations("chat");
    const [first] = links;
    if (!first) return null;
    const label = gameLinkLabel(links, t);
    return (
        <span className="inline-flex shrink-0" title={label} aria-label={label} role="img">
            <Mark link={first} className="size-3.5" />
        </span>
    );
}

/** The header's: a chip per server. */
export function GameLinkChips({ links }: { links: readonly ChatGameLinkView[] }) {
    const t = useTranslations("chat");
    if (links.length === 0) return null;
    return (
        <span className="flex min-w-0 shrink-0 items-center gap-1">
            {links.map((link) => {
                const label = t("gameLink.linkedTo", { servers: t("gameLink.server", { game: link.game, name: link.name }) });
                const body = (
                    <>
                        <Mark link={link} className="size-3.5" />
                        <span className="max-w-[10rem] truncate" title={link.name}>
                            {link.name}
                        </span>
                    </>
                );
                const chip =
                    "inline-flex min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";
                return link.href ? (
                    <Link
                        key={link.installedAppId}
                        href={link.href}
                        title={t("gameLink.open", { label })}
                        aria-label={t("gameLink.open", { label })}
                        className={cn(
                            chip,
                            "transition-colors hover:bg-card-hover hover:text-foreground"
                        )}
                    >
                        {body}
                    </Link>
                ) : (
                    <span
                        key={link.installedAppId}
                        title={label}
                        aria-label={label}
                        className={chip}
                    >
                        {body}
                    </span>
                );
            })}
        </span>
    );
}

/**
 * In a sealed conversation's member list: the servers that show it to
 * everybody playing, and what that means - the game bridge, a member the
 * server runs, reads what is said here to show it there. Drawn only while
 * sealed chat is on in this browser, as Polar's row is.
 */
export function GameBridgeRow({ links, rowClass }: { links: readonly ChatGameLinkView[]; rowClass: string }) {
    const t = useTranslations("chat");
    const showing = links.filter((link) => link.shows);
    const [first] = showing;
    if (!first || !sealedChat.sealedChatActive()) return null;
    const label = t("info.gameBridge", {
        servers: showing.map((link) => t("gameLink.server", { game: link.game, name: link.name })).join(t("gameLink.and"))
    });
    return (
        <div className="flex flex-col">
            <div className={cn(rowClass, "hover:bg-transparent")}>
                <Mark link={first} className="size-4" />
                <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                </span>
            </div>
            <p className="px-3 pb-2 text-xs text-muted-foreground">{t("info.gameBridgeHint")}</p>
        </div>
    );
}
