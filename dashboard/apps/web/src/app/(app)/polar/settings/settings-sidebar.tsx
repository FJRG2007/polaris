"use client";

/**
 * The sidebar of Polar's settings: the settings pages, in place of the chats,
 * as every Polaris app's settings do. Back to chat at its top leaves them.
 * Putting it away is the same choice the chat page remembers for its list; on
 * a narrow screen it opens as a drawer, as on /polar.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
    Brain,
    Database,
    Gauge,
    Globe,
    Menu,
    MessageSquare,
    PanelLeftClose,
    PanelLeftOpen,
    Plug,
    ScrollText,
    ShieldCheck,
    Shuffle,
    Sparkles,
    SquareTerminal,
    Wrench,
    X,
    Bot
} from "lucide-react";
import { SettingsBack } from "./settings-back";
import { useWide } from "@/components/polar/use-wide";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SIDEBAR_KEY, readStored, writeStored } from "@/lib/polar/stored";
import { Button, Dialog, DialogContent, DialogTitle, cn } from "@polaris/ui";
import { settingsSection, type PolarSettingsSection } from "@/lib/polar/settings-path";

const ICONS: Record<PolarSettingsSection, ComponentType<{ className?: string }>> = {
    memory: Brain,
    tools: Wrench,
    connectors: Plug,
    skills: ScrollText,
    agents: Bot,
    permissions: ShieldCheck,
    browser: Globe,
    display: MessageSquare,
    extras: Sparkles,
    routing: Shuffle,
    "coding-tools": SquareTerminal,
    usage: Gauge,
    data: Database
};

/** The pages in groups, so the list reads as a few short ones. */
type GroupId = "personal" | "abilities" | "models" | "privacy";
const GROUPS: readonly { id: GroupId; sections: readonly PolarSettingsSection[] }[] = [
    { id: "personal", sections: ["memory", "display", "extras"] },
    {
        id: "abilities",
        sections: ["tools", "connectors", "skills", "agents", "browser", "coding-tools"]
    },
    { id: "models", sections: ["routing", "usage"] },
    { id: "privacy", sections: ["permissions", "data"] }
];

function SettingsNav({
    sections,
    close
}: {
    sections: readonly PolarSettingsSection[];
    close: { label: string; icon: ComponentType<{ className?: string }>; onClick: () => void };
}) {
    const t = useTranslations("polar");
    const pathname = usePathname();
    const labels: Record<PolarSettingsSection, string> = {
        memory: t("settings.memory.title"),
        tools: t("settings.tools.title"),
        connectors: t("settings.nav.connectors"),
        skills: t("settings.nav.skills"),
        agents: t("settings.nav.agents"),
        permissions: t("settings.nav.permissions"),
        browser: t("settings.browserSites.title"),
        display: t("settings.display.title"),
        extras: t("settings.helper.title"),
        routing: t("settings.nav.routing"),
        "coding-tools": t("settings.nav.codingTools"),
        usage: t("settings.nav.usage"),
        data: t("settings.data.title")
    };
    const Close = close.icon;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-2 px-3 pb-2 pt-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <SettingsBack label={t("settings.back")} />
                    <p className="truncate text-sm font-semibold text-foreground">
                        {t("settings.title")}
                    </p>
                </div>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={close.label}
                    title={close.label}
                    onClick={close.onClick}
                >
                    <Close className="size-4 shrink-0" />
                </Button>
            </div>
            <nav
                aria-label={t("settings.title")}
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-3"
            >
                {[
                    ...GROUPS,
                    // A page no group names still shows, at the end.
                    {
                        id: null,
                        sections: sections.filter(
                            (id) => !GROUPS.some((group) => group.sections.includes(id))
                        )
                    }
                ].map((group) => {
                    const shown = group.sections.filter((id) => sections.includes(id));
                    if (shown.length === 0) return null;
                    const heading = group.id ? t(`settings.groups.${group.id}`) : null;
                    return (
                        <div
                            key={group.id ?? "rest"}
                            role="group"
                            aria-label={heading ?? undefined}
                            className="flex flex-col gap-0.5 pt-3 first:pt-0"
                        >
                            {heading ? (
                                <p className="truncate px-2 pb-1 text-[0.6875rem] font-medium text-foreground-subtle">
                                    {heading}
                                </p>
                            ) : null}
                            {shown.map((id) => {
                                const href = settingsSection(id);
                                const current =
                                    pathname === href || pathname.startsWith(`${href}/`);
                                const Icon = ICONS[id];
                                return (
                                    <Link
                                        key={id}
                                        href={href}
                                        aria-current={current ? "page" : undefined}
                                        className={cn(
                                            "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-card hover:text-foreground",
                                            current
                                                ? "bg-card text-foreground"
                                                : "text-muted-foreground"
                                        )}
                                    >
                                        <Icon className="size-4 shrink-0" />
                                        <span className="min-w-0 truncate" title={labels[id]}>
                                            {labels[id]}
                                        </span>
                                    </Link>
                                );
                            })}
                        </div>
                    );
                })}
            </nav>
        </div>
    );
}

export function SettingsWithSidebar({
    sections,
    children
}: {
    sections: readonly PolarSettingsSection[];
    children: ReactNode;
}) {
    const t = useTranslations("polar");
    const pathname = usePathname();
    const [hidden, setHidden] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const wide = useWide();
    useEffect(() => setHidden(readStored(SIDEBAR_KEY) === "hidden"), []);
    // A page picked in the drawer is where the drawer was going.
    useEffect(() => setDrawer(false), [pathname]);
    const hide = (next: boolean) => {
        setHidden(next);
        writeStored(SIDEBAR_KEY, next ? "hidden" : "shown");
    };
    return (
        <>
            {!hidden ? (
                <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
                    <SettingsNav
                        sections={sections}
                        close={{
                            label: t("history.hide"),
                            icon: PanelLeftClose,
                            onClick: () => hide(true)
                        }}
                    />
                </aside>
            ) : null}
            {!wide ? (
                <Dialog open={drawer} onOpenChange={setDrawer}>
                    <DialogContent
                        showClose={false}
                        aria-describedby={undefined}
                        className="left-0 top-0 flex h-full max-h-none w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-r-xl border-y-0 border-l-0 bg-card p-0 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-left-4"
                    >
                        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
                        <SettingsNav
                            sections={sections}
                            close={{
                                label: t("history.hide"),
                                icon: X,
                                onClick: () => setDrawer(false)
                            }}
                        />
                    </DialogContent>
                </Dialog>
            ) : null}
            <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6">
                {!wide || hidden ? (
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="mb-2"
                        aria-label={t("settings.showPages")}
                        title={t("settings.showPages")}
                        onClick={() => (wide ? hide(false) : setDrawer(true))}
                    >
                        {wide ? (
                            <PanelLeftOpen className="size-4 shrink-0" />
                        ) : (
                            <Menu className="size-4 shrink-0" />
                        )}
                    </Button>
                ) : null}
                {children}
            </div>
        </>
    );
}
