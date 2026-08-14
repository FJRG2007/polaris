"use client";

/**
 * Text input primitive with the shared field styling. Password fields get a
 * working show/hide eye automatically, so every form gets the same behavior for
 * free just by using <Input type="password" />.
 */

import { cn } from "../lib/cn";
import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * A field reads as a recess in the surface rather than a raised card: a slightly
 * darker fill and a hairline edge that firms up on hover. The focus ring is the
 * application's one ring (tokens.css), so nothing is restated here.
 */
const baseClass =
    "flex h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-[13px] text-foreground transition-colors duration-fast placeholder:text-foreground-subtle hover:border-border-strong focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
    const [revealed, setRevealed] = useState(false);
    const isPassword = type === "password";

    const field = (
        <input
            ref={ref}
            type={isPassword && revealed ? "text" : type}
            className={cn(baseClass, isPassword && "pr-9", className)}
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                aria-label={revealed ? "Hide password" : "Show password"}
                title={revealed ? "Hide password" : "Show password"}
            >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
        </div>
    );
});
Input.displayName = "Input";
