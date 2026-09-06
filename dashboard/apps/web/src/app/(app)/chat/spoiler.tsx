"use client";

/**
 * Something sent covered.
 *
 * The point is not secrecy - anybody who wants to see it presses it, and the
 * file was sent to them either way. The point is consent: a photograph of the
 * last page of something, or a screenshot of a result nobody has watched yet,
 * arriving unasked in a room is a thing that cannot be unseen. Covering it moves
 * the decision from the sender's judgement to the reader's.
 *
 * So it is a button, not a filter. Blur alone is guessable and, on a small
 * picture, barely a cover at all - what stands in front of it is an opaque layer
 * that says what it is hiding, and the press that removes it is the reader
 * saying they want it. Once uncovered it stays uncovered for as long as the
 * conversation is open, because covering it again the moment somebody scrolls
 * past is a thing to fight rather than a protection.
 *
 * A reader who would rather see everything says so once, in Chat's settings, and
 * this draws plainly for them - see `spoilers-shown`.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { EyeOff } from "lucide-react";
import { useSpoilersShown } from "./spoilers-shown";

export function Spoiler({
    /** What it is, in one word, for somebody deciding whether to look. */
    kind = "content",
    /** Whether there is anything to cover. False draws the children and nothing
     *  else, so every attachment can go through this without every attachment
     *  paying for it. */
    covered = true,
    className,
    children
}: {
    kind?: string;
    covered?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const always = useSpoilersShown();
    const [shown, setShown] = useState(false);
    const open = always || shown;

    if (!covered) return <>{children}</>;

    return (
        <span className={cn("relative inline-block max-w-full align-top", className)}>
            {/* Drawn underneath either way, so uncovering it costs no load and no
                jump: the picture is already there and the cover is taken off. */}
            <span
                className={cn(
                    "block transition-[filter,opacity] duration-fast",
                    open ? "" : "pointer-events-none select-none blur-lg"
                )}
                aria-hidden={open ? undefined : true}
            >
                {children}
            </span>
            {!open && (
                <button
                    type="button"
                    onClick={() => setShown(true)}
                    aria-label={`Show this ${kind}`}
                    className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg bg-background/70 text-xs font-medium text-foreground backdrop-blur-sm transition-colors hover:bg-background/60"
                >
                    <EyeOff className="size-3.5 shrink-0" />
                    Spoiler
                </button>
            )}
        </span>
    );
}
