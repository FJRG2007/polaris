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
 * Two covers, because the two things being covered are not alike:
 *
 *   Text is hidden, not blurred. A run of words behind a blur is still a run of
 *   words with a recognisable shape, and blurred text is the one thing on a
 *   screen that reads as broken rather than deliberate. It becomes a flat block
 *   the width of what it hides, and pressing it turns the block into the words.
 *
 *   A picture is blurred, and the blur is clipped to the picture's own edges.
 *   An unclipped blur spills its colour past the frame as a halo, which is the
 *   difference between a covered photograph and a glowing smudge. The layer over
 *   it is a chip that names it, not a wash across the whole thing: washing the
 *   picture out on top of blurring it hides nothing extra and looks like a
 *   failed load.
 *
 * Once uncovered it stays uncovered for as long as the conversation is open,
 * because covering it again the moment somebody scrolls past is a thing to fight
 * rather than a protection. What was covered keeps a faint ground under it after
 * the press, so a reader can still tell the sender had marked it.
 *
 * A reader who would rather see everything says so once, in Chat's settings, and
 * this draws plainly for them - see `spoilers-shown`.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { EyeOff } from "lucide-react";
import { useSpoilersShown } from "./spoilers-shown";

export function Spoiler({
    /** What it is, in one word, for somebody deciding whether to look. `text`
     *  takes the inline treatment; everything else is covered as a picture. */
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

    if (kind === "text") {
        if (open) {
            return (
                <span
                    className={cn(
                        "bg-foreground/10 rounded-[4px] px-0.5 transition-colors",
                        className
                    )}
                >
                    {children}
                </span>
            );
        }
        return (
            <button
                type="button"
                onClick={() => setShown(true)}
                aria-label="Show the hidden text"
                className={cn(
                    // Transparent ink rather than removed text: the block has to
                    // be exactly as wide as what it hides, or uncovering it
                    // reflows the sentence around it.
                    "bg-foreground/25 hover:bg-foreground/35 rounded-[4px] px-0.5 text-transparent transition-colors select-none",
                    className
                )}
            >
                {children}
            </button>
        );
    }

    return (
        <span
            className={cn(
                "relative inline-block max-w-full align-top",
                !open && "overflow-hidden rounded-lg",
                className
            )}
        >
            {/* Drawn underneath either way, so uncovering it costs no load and no
                jump: the picture is already there and the cover is taken off.
                Pushed slightly past its own frame while blurred, because a blur
                fades to nothing at the edges and would otherwise leave a pale
                border around whatever is being covered. */}
            <span
                className={cn(
                    "duration-fast block transition-[filter,transform]",
                    open ? "" : "pointer-events-none scale-105 blur-xl select-none"
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
                    className="absolute inset-0 flex items-center justify-center"
                >
                    <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-[0.6875rem] font-semibold tracking-wide text-white uppercase">
                        <EyeOff className="size-3.5 shrink-0" />
                        Spoiler
                    </span>
                </button>
            )}
        </span>
    );
}
