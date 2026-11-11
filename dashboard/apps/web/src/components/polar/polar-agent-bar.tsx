"use client";

/**
 * The line over a chat started with a custom agent: whose chat it is, a link
 * to change the agent, and the way back to plain Polar, which starts a new chat
 * since the agent stays with this one.
 */

import Link from "next/link";
import { Bot, Pencil, X } from "lucide-react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { settingsSection } from "@/lib/polar/settings-path";

export interface ChatAgent {
    id: string;
    name: string;
}

export function AgentBar({ agent, onEnd }: { agent: ChatAgent; onEnd: () => void }) {
    const t = useTranslations("polar");
    return (
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <Bot className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate" title={agent.name}>
                {t("agentBar.banner", { name: agent.name })}
            </span>
            <Button asChild size="icon-sm" variant="ghost" className="shrink-0">
                <Link
                    href={settingsSection("agents")}
                    aria-label={t("agentBar.edit")}
                    title={t("agentBar.edit")}
                >
                    <Pencil className="size-3.5 shrink-0" />
                </Link>
            </Button>
            <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="shrink-0"
                aria-label={t("agentBar.end")}
                title={t("agentBar.end")}
                onClick={onEnd}
            >
                <X className="size-3.5 shrink-0" />
            </Button>
        </div>
    );
}
