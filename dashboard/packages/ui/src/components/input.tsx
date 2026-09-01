"use client";

/**
 * Text input primitive with the shared field styling. Password fields get a
 * working show/hide eye automatically, so every form gets the same behavior for
 * free just by using <Input type="password" />.
 */

import { cn } from "../lib/cn";
import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    /**
     * A field with no edges of its own, because something around it already is
     * the field - a search row with the magnifier and the spinner in it, a
     * title that is the heading it edits.
     *
     * It exists as a prop rather than as four classes at each call site because
     * one of those four has to be `focus-visible:outline-none`, and getting that
     * wrong is invisible until somebody opens the thing: the application's focus
     * ring is an outline (tokens.css), so the Tailwind `ring-0` people reach for
     * suppresses nothing and the ring is drawn around an invisible field, inside
     * a container that was already showing where the caret is.
     */
    bare?: boolean;
}

/**
 * A field reads as a recess in the surface rather than a raised card: a slightly
 * darker fill and a hairline edge that firms up on hover. The focus ring is the
 * application's one ring (tokens.css), so nothing is restated here.
 */
const baseClass =
    "flex h-8 w-full rounded-md border border-border bg-field px-2.5 text-[0.8125rem] text-foreground transition-colors duration-fast placeholder:text-foreground-subtle hover:border-border-strong focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50";

/** What a `bare` field turns off. The container is the field, and it is the one
 *  that says where the caret is. */
const bareClass =
    "border-0 bg-transparent px-0 shadow-none hover:border-0 focus:border-0 focus-visible:outline-none";

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, bare, ...props }, ref) => {
    const [revealed, setRevealed] = useState(false);
    const isPassword = type === "password";

    const field = (
        <input
            ref={ref}
            type={isPassword && revealed ? "text" : type}
            className={cn(baseClass, bare && bareClass, isPassword && "pr-9", className)}
            {...props}
        />
    );

    if (!isPassword) return field;

    return (
        <div className="relative">
            {field}
            <button
                type="button"
                tabIndex={-1}
                onClick={() => setRevealed((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground "
                aria-label={revealed ? "Hide password" : "Show password"}
                title={revealed ? "Hide password" : "Show password"}
            >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
        </div>
    );
});
Input.displayName = "Input";
