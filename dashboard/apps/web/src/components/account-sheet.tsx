"use client";

/**
 * The account menu on a phone: a whole screen of grouped rows, the way
 * Telegram and Signal open their settings, rather than a dropdown hanging off
 * a 32px face in the corner. The same things the menu offers - who you appear
 * as, your status line, sign out - plus every screen of My account, grouped as
 * its rail groups them and offered by the same rule (`sectionOffered`), and the
 * switch between the accounts signed in on this device.
 *
 * Drawn by AccountMenu, which owns the presence and status state and their
 * dialogs; this only lays them out. Opened from the face in the header or the
 * "You" tab (see account-sheet-state).
 */

import Link from "next/link";
import * as nav from "@/lib/apps";
import { Avatar } from "@/components/avatar";
import { useState, type ReactNode } from "react";
import type { PresenceChoice } from "@polaris/core";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PRESENCE_CHOICE_DOTS } from "@/components/presence-dots";
import { cn, Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { AccountSwitcherDialog } from "@/components/device-accounts";
import { setAccountSheetOpen, useAccountSheetOpen } from "@/components/account-sheet-state";
import { AppWindow, ArrowLeftRight, Check, ChevronRight, Compass, LogOut, MessageSquareText, X } from "lucide-react";

const NO_GATE: nav.SectionGate = { isAdmin: false, held: [], installed: [] };

/** One row's look, a link or a button alike: a finger's height, the icon
 *  fixed, the name the part that gives way. */
const ROW =
    "flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-start text-sm transition-colors duration-fast hover:bg-muted active:bg-muted [-webkit-tap-highlight-color:transparent]";

function Group({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-1.5">
            {title ? (
                <h2 className="truncate px-3 text-xs font-medium text-muted-foreground" title={title}>
                    {title}
                </h2>
            ) : null}
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-surface">{children}</div>
        </section>
    );
}

function RowLabel({ children }: { children: string }) {
    return (
        <span className="min-w-0 flex-1 truncate" title={children}>
            {children}
        </span>
    );
}

export function AccountSheet({
    person,
    email,
    detail,
    presence,
    shownChoice,
    onChoose,
    status,
    onStatus,
    onTours,
    onServers,
    onSignOut,
    gate = NO_GATE
}: {
    person: { id: string; name: string };
    email: string;
    /** What the automatic state is doing right now, or empty. */
    detail: string;
    /** Each state there is to appear as, named. */
    presence: readonly { choice: PresenceChoice; label: string }[];
    shownChoice: PresenceChoice;
    onChoose: (choice: PresenceChoice) => void;
    /** The line being shown, empty for none. */
    status: string;
    onStatus: () => void;
    onTours: () => void;
    /** Only in the desktop app, which has servers to switch between. */
    onServers?: () => void;
    onSignOut: () => void;
    /** What this account can open, for which screens of My account to offer. */
    gate?: nav.SectionGate;
}) {
    const t = useTranslations("nav");
    const tTours = useTranslations("tours");
    const label = useNavLabel();
    const open = useAccountSheetOpen();
    const [switching, setSwitching] = useState(false);
    const close = () => setAccountSheetOpen(false);
    // Closed before whatever the row does next, so a dialog it opens replaces
    // this screen rather than stacking on it.
    const then = (action: () => void) => () => {
        close();
        action();
    };

    const account = nav.POLARIS_APPS.find((app) => app.id === "account");
    const sections = (nav.APP_SECTIONS.account ?? []).filter(
        (section) => !section.hidden && nav.sectionOffered(section, gate)
    );
    const groups = nav.sectionGroups(sections, account ? label(account.label) : "", label);

    return (
        <>
            <Dialog open={open} onOpenChange={setAccountSheetOpen}>
                <DialogContent phone="full" showClose={false} className="flex max-w-md flex-col gap-5 bg-background">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                        <DialogTitle className="min-w-0 truncate text-[1.0625rem] font-semibold">
                            {t("phoneTabs.you")}
                        </DialogTitle>
                        <button
                            type="button"
                            onClick={close}
                            aria-label={t("account.sheet.close")}
                            className="-me-2 grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <X className="size-5 shrink-0" />
                        </button>
                    </div>

                    <Link href="/account" onClick={close} className="flex min-w-0 items-center gap-3 rounded-xl bg-surface p-3">
                        <Avatar person={person} size={56} className="shrink-0" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-base font-semibold" title={person.name}>
                                {person.name}
                            </span>
                            <span className="truncate text-sm text-muted-foreground" title={email}>
                                {email}
                            </span>
                            {detail ? (
                                <span className="truncate text-xs text-muted-foreground" title={detail}>
                                    {detail}
                                </span>
                            ) : null}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                    </Link>

                    <Group title={t("account.sheet.status")}>
                        {presence.map((row) => (
                            <button
                                key={row.choice}
                                type="button"
                                className={ROW}
                                aria-pressed={shownChoice === row.choice}
                                onClick={() => onChoose(row.choice)}
                            >
                                <span className="grid size-5 shrink-0 place-items-center">
                                    <span
                                        aria-hidden="true"
                                        className={cn("size-2.5 rounded-full", PRESENCE_CHOICE_DOTS[row.choice])}
                                    />
                                </span>
                                <RowLabel>{row.label}</RowLabel>
                                {shownChoice === row.choice ? (
                                    <Check className="size-4 shrink-0 text-primary" />
                                ) : null}
                            </button>
                        ))}
                        <button type="button" className={ROW} onClick={then(onStatus)}>
                            <MessageSquareText className="size-5 shrink-0 text-muted-foreground" />
                            <RowLabel>{status || t("account.setStatus")}</RowLabel>
                        </button>
                    </Group>

                    {groups.map((group) => (
                        <Group key={group.label} title={group.label}>
                            {group.items.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <Link key={item.href} href={item.href} onClick={close} className={ROW}>
                                        <Icon className="size-5 shrink-0 text-muted-foreground" />
                                        <RowLabel>{label(item.label)}</RowLabel>
                                        <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                                    </Link>
                                );
                            })}
                        </Group>
                    ))}

                    <Group>
                        <button type="button" className={ROW} onClick={then(onTours)}>
                            <Compass className="size-5 shrink-0 text-muted-foreground" />
                            <RowLabel>{tTours("menu")}</RowLabel>
                        </button>
                        {onServers ? (
                            <button type="button" className={ROW} onClick={then(onServers)}>
                                <AppWindow className="size-5 shrink-0 text-muted-foreground" />
                                <RowLabel>{t("account.servers")}</RowLabel>
                            </button>
                        ) : null}
                    </Group>

                    <Group>
                        <button type="button" className={ROW} onClick={then(() => setSwitching(true))}>
                            <ArrowLeftRight className="size-5 shrink-0 text-muted-foreground" />
                            <RowLabel>{t("account.switcher.title")}</RowLabel>
                        </button>
                        <button type="button" className={cn(ROW, "text-danger-ink")} onClick={then(onSignOut)}>
                            <LogOut className="size-5 shrink-0" />
                            <RowLabel>{t("account.signOut")}</RowLabel>
                        </button>
                    </Group>
                </DialogContent>
            </Dialog>
            <AccountSwitcherDialog open={switching} onOpenChange={setSwitching} />
        </>
    );
}
