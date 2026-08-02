"use client";

/**
 * Multi-line text field with the shared field styling.
 *
 * It exists mainly to settle one thing everywhere at once: a textarea has a
 * floor and a ceiling. Left to the browser, the drag handle goes to a single
 * illegible line in one direction and past the end of the page in the other,
 * which pushes the buttons under it out of reach - so a box that could be
 * resized became a box that had to be. The defaults here keep it between three
 * lines and half the viewport; `rows` raises the floor, and a caller with a
 * genuinely different shape overrides `min-h`/`max-h` through className.
 */

import { cn } from "../lib/cn";
import { forwardRef, type TextareaHTMLAttributes } from "react";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

const baseClass =
    "flex min-h-[4.5rem] max-h-[50vh] w-full resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(baseClass, className)} {...props} />
));
Textarea.displayName = "Textarea";
