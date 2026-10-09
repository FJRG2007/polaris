"use client";

/**
 * A space's own emoji, drawn where text is.
 *
 * What draws one is handed the set it may draw from - the emoji of the space
 * the text was written in - and nothing else. A token for an emoji outside that
 * set, deleted since, or met where no set was handed in at all (a task, a note,
 * a direct message) reads as its name, `:wave:`, which is what it was typed as.
 * That keeps "only in its own space" a property of what is on screen as well as
 * of what the server stores.
 *
 * Hovering one says its name; pressing it says where it is from, the way Discord
 * answers the same press.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@polaris/ui";

/** One emoji a set can draw. */
export interface CustomEmojiEntry {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
    readonly src: string;
}

/** The emoji a piece of text may draw, and the space they belong to. */
export interface CustomEmojiSet {
    readonly entries: ReadonlyMap<string, CustomEmojiEntry>;
    /** The space's name, for the card a press opens. */
    readonly from: string;
}

/** A run of text with its tokens drawn: a picture where the set has one, the
 *  name where it does not. */
export function EmojiRun({
    text,
    set,
    jumbo = false
}: {
    text: string;
    set: CustomEmojiSet | null;
    jumbo?: boolean;
}) {
    return (
        <>
            {core.splitCustomEmoji(text).map((part, index) => {
                if (part.emoji === undefined) return part.text;
                const entry = set?.entries.get(part.emoji.id);
                if (!entry) return core.customEmojiFallback(part.emoji);
                return (
                    <CustomEmojiGlyph key={index} entry={entry} from={set!.from} jumbo={jumbo} />
                );
            })}
        </>
    );
}

/**
 * One emoji or a reaction's worth: an ordinary one as itself, a space's own as
 * its picture or its name. For the places that hold exactly one - a reaction
 * chip, a quick reaction - and never sentence text.
 */
export function EmojiFace({
    value,
    set,
    className
}: {
    value: string;
    set: CustomEmojiSet | null;
    className?: string;
}) {
    const ref = core.parseCustomEmojiToken(value);
    if (!ref) return <span className={className}>{value}</span>;
    const entry = set?.entries.get(ref.id);
    if (!entry) return <span className={className}>{core.customEmojiFallback(ref)}</span>;
    return <EmojiPicture entry={entry} className={cn("size-[1.25em]", className)} />;
}

/** The picture alone, at whatever size the caller gives it. */
export function EmojiPicture({
    entry,
    className
}: {
    entry: CustomEmojiEntry;
    className?: string;
}) {
    const label = core.customEmojiFallback(entry);
    return (
        <img
            src={entry.src}
            alt={label}
            title={label}
            draggable={false}
            loading="lazy"
            className={cn("inline-block object-contain align-[-0.25em]", className)}
        />
    );
}

/** One in a sentence: its name on hover, where it is from on a press. */
function CustomEmojiGlyph({
    entry,
    from,
    jumbo
}: {
    entry: CustomEmojiEntry;
    from: string;
    jumbo: boolean;
}) {
    const t = useTranslations("components");
    const label = core.customEmojiFallback(entry);
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={label}
                    title={label}
                    className="mx-px inline-flex rounded align-[-0.3em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                    <EmojiPicture entry={entry} className={jumbo ? "size-12" : "size-[1.375em]"} />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60 p-3">
                <div className="flex items-center gap-3">
                    <EmojiPicture entry={entry} className="size-12 shrink-0" />
                    <div className="min-w-0 text-sm">
                        <p className="truncate font-semibold" title={label}>
                            {label}
                        </p>
                        <p className="truncate text-xs text-muted-foreground" title={from}>
                            {t("customEmoji.from", { space: from })}
                        </p>
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
