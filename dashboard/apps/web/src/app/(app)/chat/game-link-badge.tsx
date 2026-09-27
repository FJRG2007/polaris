"use client";

/**
 * The mark on a conversation a game server is linked to (`lib/chat/game-links`):
 * the game's logo beside its name in the rail, and a chip in the header naming
 * the server - a link to its page for somebody who may open it, and only words
 * for everybody else.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { Gamepad2 } from "lucide-react";
import type { ChatGameLinkView } from "@/lib/chat/game-links";

/** What a link is called in a sentence: "the Minecraft server Survival". */
export function gameLinkLabel(links: readonly ChatGameLinkView[]): string {
    const named = links.map((link) => `the ${link.game} server ${link.name}`);
    return `Linked to ${named.join(" and ")}`;
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
    const [first] = links;
    if (!first) return null;
    const label = gameLinkLabel(links);
    return (
        <span className="inline-flex shrink-0" title={label} aria-label={label} role="img">
            <Mark link={first} className="size-3.5" />
        </span>
    );
}

/** The header's: a chip per server. */
export function GameLinkChips({ links }: { links: readonly ChatGameLinkView[] }) {
    if (links.length === 0) return null;
    return (
        <span className="flex min-w-0 shrink-0 items-center gap-1">
            {links.map((link) => {
                const label = `Linked to the ${link.game} server ${link.name}`;
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
                        title={`${label}. Open its page.`}
                        aria-label={`${label}. Open its page.`}
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
