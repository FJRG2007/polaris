/**
 * Class-name combiner. clsx resolves conditional classes; tailwind-merge then
 * de-duplicates conflicting Tailwind utilities so the last one wins (e.g. a
 * caller passing `p-2` overrides a component's default `p-4`).
 *
 * The interface uses logical sides (`ps-2`, `start-0`, `rounded-se`) so it
 * mirrors in a right-to-left language. tailwind-merge already lets `p-*` replace
 * them, but not the axis shorthands: without these, a caller's `px-3` would sit
 * beside a component's `ps-2` - and lose to it, since Tailwind emits `ps` after
 * `px` - where the physical `pl-2` it replaced used to be dropped.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
    extend: {
        conflictingClassGroups: {
            px: ["ps", "pe"],
            mx: ["ms", "me"],
            "inset-x": ["start", "end"],
            "rounded-t": ["rounded-ss", "rounded-se"],
            "rounded-b": ["rounded-es", "rounded-ee"],
            "border-w-x": ["border-w-s", "border-w-e"],
            "border-color-x": ["border-color-s", "border-color-e"],
            "scroll-mx": ["scroll-ms", "scroll-me"],
            "scroll-px": ["scroll-ps", "scroll-pe"]
        }
    }
});

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
