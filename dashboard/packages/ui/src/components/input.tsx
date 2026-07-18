"use client";

/**
 * Text input primitive with the shared field styling. Password fields get a
 * working show/hide eye automatically, so every form gets the same behavior for
 * free just by using <Input type="password" />.
 */

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

const baseClass =
    "flex h-9 w-full rounded-md border border-input bg-surface px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

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
