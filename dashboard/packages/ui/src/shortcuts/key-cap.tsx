/**
 * Key caps, apart from the shortcut registry so a surface that carries none of
 * it (the desktop's own search panel, the extension's on-page launcher, the
 * site's docs search) draws the very same caps. Only React, the icons and `cn`.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, CornerDownLeft, Delete } from "lucide-react";

/** One key cap, drawn the way the diagram editor's help draws one. */
export function KeyCap({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <kbd
            className={cn(
                "inline-flex min-w-6 items-center justify-center rounded-md bg-primary/15 px-2 py-1.5 font-sans text-[11px] font-medium leading-none text-foreground",
                className
            )}
        >
            {children}
        </kbd>
    );
}

/** The keys a hint shows as a symbol rather than a word, as Raycast's footer does. */
export const KEY_GLYPHS = {
    up: <ArrowUp className="size-3 shrink-0" />,
    down: <ArrowDown className="size-3 shrink-0" />,
    enter: <CornerDownLeft className="size-3 shrink-0" />,
    backspace: <Delete className="size-3 shrink-0" />
} as const;

/** One key of a hint: what the cap shows, and the key's name read out instead. */
export interface HintKey {
    readonly cap: ReactNode;
    readonly name: string;
}

/**
 * A key hint for a footer: the caps, then what they do - "[up][down] Move".
 * The caps are hidden from a screen reader, which hears the keys' names
 * before the words instead of a row of arrows.
 */
export function KeyHint({
    keys,
    label,
    className
}: {
    keys: readonly HintKey[];
    label: string;
    className?: string;
}) {
    return (
        <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
            <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
                {keys.map((key, at) => (
                    <KeyCap key={at} className="h-5 min-w-5 px-1 py-0 text-[10px]">
                        {key.cap}
                    </KeyCap>
                ))}
            </span>
            <span className="sr-only">{`${keys.map((key) => key.name).join(", ")}: `}</span>
            <span className="truncate">{label}</span>
        </span>
    );
}
