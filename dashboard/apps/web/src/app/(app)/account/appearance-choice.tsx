"use client";

/**
 * The two shapes every appearance option is offered in.
 *
 * A chip when the answer fits in a word painted the way it will be - an effect,
 * a face, a colour - and a tile when the answer is a picture and the word under
 * it is only there so a screen reader has something to say and so two people can
 * name the same one out loud.
 *
 * They live apart from the card because the card is no longer the only thing
 * that offers them: the name style is its own picker now, and a second copy of a
 * button is how two rows of the same screen end up a pixel apart.
 */

import { cn } from "@polaris/ui";
import type { CSSProperties, ReactNode } from "react";

/** One option. The picture on it is the answer; the word beside it is only there
 *  so the picture can be named out loud. */
export function Choice({
    chosen,
    onClick,
    label,
    style,
    labelClass,
    children
}: {
    chosen: boolean;
    onClick: () => void;
    label: string;
    style?: CSSProperties;
    /** For a treatment that needs keyframes as well as properties - the colours
     *  of a moving name are a class, since a `style` attribute cannot hold one. */
    labelClass?: string;
    children?: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={chosen}
            className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                chosen
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-card-hover hover:text-foreground"
            )}
        >
            {children}
            <span className={labelClass} style={style}>
                {label}
            </span>
        </button>
    );
}

/**
 * One tile of the gallery: a drawing, its name, and whether it moves.
 *
 * A tile rather than a chip because what is being chosen is a picture. The name
 * under it is what a screen reader announces and what somebody says out loud
 * when they want the one their colleague has; it is not what the choice is made
 * on.
 */
export function Tile({
    chosen,
    onClick,
    label,
    note,
    children
}: {
    chosen: boolean;
    onClick: () => void;
    label: string;
    note?: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={chosen}
            title={note ? `${label} - ${note.toLowerCase()}` : label}
            className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 transition-colors",
                chosen
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-card-hover hover:text-foreground"
            )}
        >
            {children}
            <span className="w-full truncate px-1 text-center text-[0.6875rem] leading-tight">
                {label}
            </span>
            {/* Only on the ones it is true of, so the row of words under the
                gallery stays quiet. */}
            {note ? (
                <span className="text-muted-foreground text-[0.625rem] leading-none">{note}</span>
            ) : null}
        </button>
    );
}
