"use client";

/**
 * Suggestion: things to ask, one click each.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/suggestion.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3, Polaris tokens and Button,
 * wrapping rows instead of a horizontal scroll area, and no capsules (the
 * design system keeps those for avatars and switches).
 */

import { Button, cn } from "@polaris/ui";
import type { HTMLAttributes } from "react";

export function Suggestions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-wrap justify-center gap-2", className)} {...props} />;
}

export function Suggestion({
    suggestion,
    onClick
}: {
    suggestion: string;
    onClick: (suggestion: string) => void;
}) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-w-full"
            onClick={() => onClick(suggestion)}
        >
            <span className="truncate" title={suggestion}>
                {suggestion}
            </span>
        </Button>
    );
}
