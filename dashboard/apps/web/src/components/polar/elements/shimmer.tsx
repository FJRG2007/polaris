/**
 * Shimmer: text with a light passing over it, for "working on it".
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/shimmer.tsx at ca8be60), Apache-2.0 - see the LICENSE
 * beside this file. Changed: a CSS animation (`polar-shimmer` in globals.css,
 * off under reduced motion) instead of `motion`, on Polaris's text tokens.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
    return <span className={cn("polar-shimmer", className)}>{children}</span>;
}
