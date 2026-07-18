/**
 * Class-name combiner. clsx resolves conditional classes; tailwind-merge then
 * de-duplicates conflicting Tailwind utilities so the last one wins (e.g. a
 * caller passing `p-2` overrides a component's default `p-4`).
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
