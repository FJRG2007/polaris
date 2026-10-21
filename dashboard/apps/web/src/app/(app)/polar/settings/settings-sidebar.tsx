"use client";

/**
 * Polar's conversation list beside its settings, the same one /polar shows:
 * settings are a page of Polar, not a place that leaves it. Opening a chat or
 * starting one goes to /polar with it; putting the list away is the same
 * choice the chat page remembers.
 */

import { Button } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { readStored, writeStored } from "@/lib/polar/stored";
import { PolarThreads } from "@/components/polar/polar-threads";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { usePolarSidebar } from "@/components/polar/use-polar-sidebar";

/** The chat page's own keys, so both pages agree. */
const SIDEBAR_KEY = "polar.sidebar";
const THREAD_KEY = "polar.thread";

export function SettingsWithSidebar({ children }: { children: ReactNode }) {
    const t = useTranslations("polar");
    const router = useRouter();
    const [hidden, setHidden] = useState(false);
    useEffect(() => setHidden(readStored(SIDEBAR_KEY) === "hidden"), []);
    const sidebar = usePolarSidebar({ enabled: !hidden, onRemoved: () => undefined });
    const hide = (next: boolean) => {
        setHidden(next);
        writeStored(SIDEBAR_KEY, next ? "hidden" : "shown");
    };
    return (
        <>
            {!hidden ? (
                <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
                    <PolarThreads
                        sidebar={sidebar}
                        activeId=""
                        onOpen={(id) => router.push(`/polar?thread=${encodeURIComponent(id)}`)}
                        onNew={(projectId) => {
                            writeStored(THREAD_KEY, "");
                            router.push(
                                projectId
                                    ? `/polar?new=${encodeURIComponent(projectId)}`
                                    : "/polar?new=1"
                            );
                        }}
                        hide={{
                            label: t("history.hide"),
                            icon: PanelLeftClose,
                            onClick: () => hide(true)
                        }}
                    />
                </aside>
            ) : null}
            <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
                {hidden ? (
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="mb-2 hidden md:inline-flex"
                        aria-label={t("history.show")}
                        title={t("history.show")}
                        onClick={() => hide(false)}
                    >
                        <PanelLeftOpen className="size-4 shrink-0" />
                    </Button>
                ) : null}
                {children}
            </div>
        </>
    );
}
