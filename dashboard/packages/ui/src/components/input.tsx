/** Text input primitive with the shared field styling. */

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
    <input
        ref={ref}
        type={type}
        className={cn(
            "flex h-9 w-full rounded-md border border-input bg-surface px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
        )}
        {...props}
    />
));
Input.displayName = "Input";
