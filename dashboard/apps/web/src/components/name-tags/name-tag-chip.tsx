"use client";

/**
 * A name tag as it sits after somebody's name: the emblem and up to four
 * letters, small enough to share a row with the name without fighting it.
 * Clicking it opens a card about whoever the tag belongs to.
 */

import { useState } from "react";
import { Users } from "lucide-react";
import * as core from "@polaris/core";
import { nameTagCardAction } from "@/app/(app)/name-tag-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NameTagCard } from "@/lib/name-tags/name-tag-service";
import {
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** Each color, readable on light and dark surfaces alike. */
export const NAME_TAG_HEX: Record<core.NameTagColor, string> = {
    slate: "#64748b",
    red: "#e5484d",
    amber: "#d97706",
    green: "#30a46c",
    teal: "#0d9488",
    blue: "#3b82f6",
    violet: "#8b5cf6",
    pink: "#e93d82"
};

/** The drawn emblems, on a 16-unit grid. */
const EMBLEM_PATHS: Record<core.NameTagEmblem, string> = {
    spark: "M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z",
    shield: "M8 1.5l5.5 2v4.2c0 3.3-2.3 5.8-5.5 6.8-3.2-1-5.5-3.5-5.5-6.8V3.5z",
    bolt: "M9.2 1.5L3.5 9h4l-1 5.5L12.5 7h-4z",
    leaf: "M13.5 2.5C7 2.5 2.5 5.5 2.5 10.5c0 1.3.4 2.3 1 3 .8-3 2.8-5.3 6-6.8-2.6 1.8-4.2 4-4.9 6.9.6.2 1.2.4 1.9.4 5 0 7-5 7-11.5z",
    flame: "M8 1.5c.5 2.5 4.5 4.3 4.5 8 0 2.8-2 5-4.5 5s-4.5-2.2-4.5-5c0-2 1-3.3 2-4.2 0 1.4.6 2.4 1.6 2.7C7 6 7.2 3.6 8 1.5z",
    gem: "M4.5 2.5h7l3 3.8L8 14 1.5 6.3z",
    wave: "M1.5 9.5c1.6 0 1.6-2 3.25-2s1.6 2 3.25 2 1.6-2 3.25-2 1.6 2 3.25 2v3H1.5zM1.5 5c1.6 0 1.6-2 3.25-2S6.35 5 8 5s1.6-2 3.25-2 1.6 2 3.25 2v2c-1.6 0-1.6-2-3.25-2S9.65 7 8 7 6.4 5 4.75 5 3.1 7 1.5 7z",
    orbit: "M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM8 1.5c3.9 0 7 1.6 7 3.5 0 .7-.4 1.3-1.1 1.9l-.9-.8c.3-.4.5-.8.5-1.1C13.5 3.8 11 2.6 8 2.6S2.5 3.8 2.5 5c0 .3.2.7.5 1.1l-.9.8C1.4 6.3 1 5.7 1 5c0-1.9 3.1-3.5 7-3.5zm-6.5 8l.9.8c-.3.4-.4.7-.4 1 0 1.2 2.5 2.4 6 2.4s6-1.2 6-2.4c0-.3-.1-.6-.4-1l.9-.8c.6.6.9 1.2.9 1.8 0 1.9-3.1 3.2-7.4 3.2S.6 13.2.6 11.3c0-.6.3-1.2.9-1.8z"
};

export function NameTagEmblemMark({
    emblem,
    color,
    image,
    className
}: {
    emblem: string;
    color: core.NameTagColor;
    image?: string | null;
    className?: string;
}) {
    if (emblem === core.NAME_TAG_AVATAR && image) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={image}
                alt=""
                className={cn("size-3 shrink-0 rounded-[3px] object-cover", className)}
            />
        );
    }
    const path = EMBLEM_PATHS[emblem as core.NameTagEmblem] ?? EMBLEM_PATHS.spark;
    return (
        <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={cn("size-3 shrink-0", className)}
            fill={NAME_TAG_HEX[color] ?? NAME_TAG_HEX.blue}
        >
            <path d={path} fillRule="evenodd" />
        </svg>
    );
}

/** The tag itself, with nothing to click. Used by previews and pickers. */
export function NameTagLabel({ tag, className }: { tag: core.NameTagView; className?: string }) {
    return (
        <span
            className={cn(
                "border-border bg-muted text-foreground inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1 py-px align-middle text-[10px] leading-4 font-semibold tracking-wide",
                className
            )}
        >
            <NameTagEmblemMark emblem={tag.emblem} color={tag.color} image={tag.image} />
            <span>{tag.text}</span>
        </span>
    );
}

/**
 * The tag after a name, opening its card. A `span` with a button's role rather
 * than a `button`: names are drawn inside rows that are already links and
 * buttons, and a button inside one is not valid markup.
 */
export function NameTagButton({ tag, personId }: { tag: core.NameTagView; personId: string }) {
    const t = useTranslations("common");
    const [card, setCard] = useState<NameTagCard | null | "loading">(null);
    const label = t("nameTag.open", { tag: tag.text });

    const open = async (event: { stopPropagation(): void; preventDefault(): void }) => {
        event.stopPropagation();
        event.preventDefault();
        setCard("loading");
        const answer = await nameTagCardAction(personId).catch(() => null);
        setCard(answer ?? null);
    };

    return (
        <>
            <span
                role="button"
                tabIndex={0}
                aria-label={label}
                title={label}
                onClick={open}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") void open(event);
                }}
                className="focus-visible:ring-ring ml-1 inline-flex shrink-0 cursor-pointer rounded-[5px] align-middle focus-visible:ring-2 focus-visible:outline-none"
            >
                <NameTagLabel tag={tag} />
            </span>
            {card !== null && (
                <Dialog open onOpenChange={(next) => !next && setCard(null)}>
                    <DialogContent
                        className="max-w-xs"
                        onClick={(event) => event.stopPropagation()}
                    >
                        {card === "loading" ? (
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <NameTagLabel tag={tag} />
                                </DialogTitle>
                                <DialogDescription>{t("nameTag.loading")}</DialogDescription>
                            </DialogHeader>
                        ) : (
                            <NameTagCardBody card={card} />
                        )}
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}

function NameTagCardBody({ card }: { card: NameTagCard }) {
    const t = useTranslations("common");
    return (
        <DialogHeader>
            <div className="flex min-w-0 items-center gap-3">
                <span className="bg-muted border-border flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
                    {card.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={card.image} alt="" className="size-full object-cover" />
                    ) : (
                        <NameTagEmblemMark
                            emblem={card.tag.emblem}
                            color={card.tag.color}
                            className="size-6"
                        />
                    )}
                </span>
                <div className="min-w-0">
                    <DialogTitle className="truncate" title={card.name}>
                        {card.name}
                    </DialogTitle>
                    <DialogDescription className="flex items-center gap-2">
                        <NameTagLabel tag={card.tag} />
                        {card.memberCount !== null && (
                            <span className="inline-flex items-center gap-1">
                                <Users className="size-3.5 shrink-0" />
                                {t("nameTag.members", { count: card.memberCount })}
                            </span>
                        )}
                    </DialogDescription>
                </div>
            </div>
            <p className="text-muted-foreground text-xs">
                {card.href ? t("nameTag.orgHint") : t("nameTag.instanceHint")}
            </p>
            {card.href && (
                <a href={card.href} className="text-primary text-sm font-medium hover:underline">
                    {t("nameTag.view")}
                </a>
            )}
        </DialogHeader>
    );
}
