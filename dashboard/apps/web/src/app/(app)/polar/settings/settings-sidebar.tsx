"use client";

/**
 * Polar's conversation list beside its settings, the same one /polar shows,
 * Code sessions included: settings are a page of Polar, not a place that
 * leaves it. Opening a chat or a session, or starting one, goes to /polar
 * with it; putting the list away is the same
 * choice the chat page remembers. On a narrow screen it opens as a drawer, as
 * on /polar.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useWide } from "@/components/polar/use-wide";
import { PolarThreads } from "@/components/polar/polar-threads";
import { usePolarCode } from "@/components/polar/polar-code";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { usePolarSidebar } from "@/components/polar/use-polar-sidebar";
import { SIDEBAR_KEY, THREAD_KEY, readStored, writeStored } from "@/lib/polar/stored";

export function SettingsWithSidebar({ children }: { children: ReactNode }) {
    const t = useTranslations("polar");
    const router = useRouter();
    const [hidden, setHidden] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const wide = useWide();
    useEffect(() => setHidden(readStored(SIDEBAR_KEY) === "hidden"), []);
    const listed = !hidden || drawer;
    const sidebar = usePolarSidebar({ enabled: listed, onRemoved: () => undefined });
    const code = usePolarCode({ enabled: listed });
    const codeMode = code.mode === "code";
    const hide = (next: boolean) => {
        setHidden(next);
        writeStored(SIDEBAR_KEY, next ? "hidden" : "shown");
    };
    const threadList = (close: Parameters<typeof PolarThreads>[0]["hide"]) => (
        <PolarThreads
            sidebar={sidebar}
            activeId=""
            onOpen={(id) => router.push(`/polar?thread=${encodeURIComponent(id)}`)}
            onNew={(projectId) => {
                if (projectId === null && codeMode) {
                    router.push("/polar?session=new");
                    return;
                }
                writeStored(THREAD_KEY, "");
                router.push(
                    projectId ? `/polar?new=${encodeURIComponent(projectId)}` : "/polar?new=1"
                );
            }}
            hide={close}
            newLabel={codeMode ? t("code.newTask") : undefined}
            code={
                code.access === null || code.access === "none"
                    ? null
                    : {
                          history: code.history,
                          activeId: null,
                          first: codeMode,
                          onOpen: (id) => router.push(`/polar?session=${encodeURIComponent(id)}`)
                      }
            }
        />
    );
    return (
        <>
            {!hidden ? (
                <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
                    {threadList({
                        label: t("history.hide"),
                        icon: PanelLeftClose,
                        onClick: () => hide(true)
                    })}
                </aside>
            ) : null}
            {!wide ? (
                <Dialog open={drawer} onOpenChange={setDrawer}>
                    <DialogContent
                        showClose={false}
                        aria-describedby={undefined}
                        className="left-0 top-0 flex h-full max-h-none w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-r-xl border-y-0 border-l-0 bg-card p-0 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-left-4"
                    >
                        <DialogTitle className="sr-only">{t("history.title")}</DialogTitle>
                        {threadList({
                            label: t("history.close"),
                            icon: X,
                            onClick: () => setDrawer(false)
                        })}
                    </DialogContent>
                </Dialog>
            ) : null}
            <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6">
                {!wide ? (
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="mb-2"
                        aria-label={t("history.show")}
                        title={t("history.show")}
                        onClick={() => setDrawer(true)}
                    >
                        <Menu className="size-4 shrink-0" />
                    </Button>
                ) : hidden ? (
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="mb-2"
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
