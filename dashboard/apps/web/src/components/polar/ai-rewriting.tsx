"use client";

/**
 * Wraps a field while "Improve" rewrites what is in it: the text dims under a
 * moving band of light and a "Rewriting" chip, and nothing in it can be
 * clicked or typed into until the new text arrives - typing into text about to
 * be replaced is typing that is lost. Around any field: a rich text editor, a
 * textarea, a composer.
 */

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function AiRewriting({
    active,
    children,
    className
}: {
    active: boolean;
    children: ReactNode;
    className?: string;
}) {
    const t = useTranslations("components");
    return (
        <div
            className={cn("relative rounded-md", active && "ai-rewriting", className)}
            aria-busy={active || undefined}
        >
            <div
                className={cn(
                    "flex min-h-0 flex-1 flex-col",
                    active && "ai-rewriting-content pointer-events-none select-none"
                )}
            >
                {children}
            </div>
            {active ? (
                <>
                    <div aria-hidden className="ai-rewriting-veil" />
                    <span
                        role="status"
                        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm"
                    >
                        <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
                        {t("improve.rewriting")}
                    </span>
                </>
            ) : null}
        </div>
    );
}
