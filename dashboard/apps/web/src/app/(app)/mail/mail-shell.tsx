"use client";

/**
 * The columns Mail is read in, and the state every screen inside shares.
 *
 * Mail has no entry in APP_SECTIONS on purpose, exactly as Chat does not: what
 * belongs in its rail is one server's folder list, which differs per mailbox and
 * is only known once a mailbox has been synced. A fixed rail above a live one
 * would be two navigations stacked on each other.
 *
 * Full height with its own scrolling. A mail client that scrolled the page would
 * put the composer and the toolbar below the fold the moment a conversation got
 * long, and those are the controls that must never move.
 *
 * On a phone the columns collapse to one: the rail is in the header drawer, and
 * the list gives way to the conversation once one is open, with a way back.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { MailRail } from "./mail-rail";
import { Composer } from "./composer";
import { FolderRoleDialog, type MissingFolderRole } from "./folder-role-dialog";
import { Menu, PenLine } from "lucide-react";
import { Button, PAGE_BLEED } from "@polaris/ui";
import { useMailStream } from "./use-mail-stream";
import type { MailIdentityView, MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface MailContextValue {
    readonly accounts: readonly MailAccountView[];
    readonly folders: readonly MailFolderView[];
    readonly labels: readonly MailLabelView[];
    /** The addresses each mailbox may send as, keyed by mailbox. */
    readonly identities: Readonly<Record<string, readonly MailIdentityView[]>>;
    readonly unread: { total: number; byAccount: Record<string, number> };
    readonly viewerName: string;
    /** Pull everything the server drew again. The answer to every live frame:
     *  one small query, against teaching the client to apply every kind of
     *  change to a shape the server already knows how to build. */
    readonly refresh: () => void;
    /** The colour standing for one mailbox, so a row in a merged list says which
     *  mailbox it came from without being read. */
    readonly accountColor: (accountId: string) => string;
    readonly openComposer: (draft: ComposerSeed | null) => void;
    readonly composing: ComposerSeed | null;
    /**
     * Ask which folder is this mailbox's Trash, Archive or Junk, and run `retry`
     * once one holds the role.
     *
     * Raised from wherever an action refused for want of a folder, which is two
     * screens and will be more - so the question lives in the shell rather than
     * being drawn twice.
     */
    readonly askFolderRole: (missing: MissingFolderRole, retry: () => void) => void;
}

/** What the composer opens with. Null closes it. */
export interface ComposerSeed {
    readonly accountId?: string;
    readonly to?: readonly { name: string; address: string }[];
    readonly cc?: readonly { name: string; address: string }[];
    readonly subject?: string;
    readonly body?: string;
    readonly inReplyToId?: string | null;
    readonly forward?: boolean;
    readonly draftId?: string | null;
}

const MailContext = createContext<MailContextValue | null>(null);

export function useMail(): MailContextValue {
    const held = useContext(MailContext);
    if (!held) throw new Error("useMail outside the Mail shell");
    return held;
}

/**
 * The colours a mailbox is told apart by when its owner has not chosen one.
 *
 * Derived from the address rather than from the row's position, so a mailbox
 * keeps its colour when another is added above it - a rail whose colours shuffle
 * on every change is a rail nobody learns.
 */
const ACCOUNT_COLORS = [
    "#6366f1",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#a855f7",
    "#14b8a6",
    "#f43f5e"
];

function colorFor(seed: string): string {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) | 0;
    }
    return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0]!;
}

export function MailShell({
    accounts,
    folders,
    labels,
    identities,
    unread,
    viewerName,
    children
}: {
    accounts: MailAccountView[];
    folders: MailFolderView[];
    labels: MailLabelView[];
    identities: Record<string, MailIdentityView[]>;
    unread: { total: number; byAccount: Record<string, number> };
    viewerName: string;
    children: ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const [composing, setComposing] = useState<ComposerSeed | null>(null);
    const [railOpen, setRailOpen] = useState(false);
    const [asking, setAsking] = useState<{ missing: MissingFolderRole; retry: () => void } | null>(null);

    const refresh = useCallback(() => router.refresh(), [router]);
    useMailStream(refresh);

    const accountColor = useCallback(
        (accountId: string) => {
            const account = accounts.find((one) => one.id === accountId);
            return account?.color ?? colorFor(account?.address ?? accountId);
        },
        [accounts]
    );

    const askFolderRole = useCallback(
        (missing: MissingFolderRole, retry: () => void) => setAsking({ missing, retry }),
        []
    );

    const value = useMemo<MailContextValue>(
        () => ({
            accounts,
            folders,
            labels,
            identities,
            unread,
            viewerName,
            refresh,
            accountColor,
            composing,
            openComposer: setComposing,
            askFolderRole
        }),
        [accounts, folders, labels, identities, unread, viewerName, refresh, accountColor, composing, askFolderRole]
    );

    // Inside a conversation on a phone the list steps aside, which is why this
    // decides a class rather than a render: the list keeps its scroll position
    // and its selection while it is off screen.
    const reading = Boolean(search.get("open")) || pathname.startsWith("/mail/t/");
    const inSettings = pathname.startsWith("/mail/settings");

    return (
        <MailContext.Provider value={value}>
            <div className={cn(PAGE_BLEED, "flex h-full min-h-0 overflow-hidden")}>
                <aside
                    className={cn(
                        "w-60 shrink-0 flex-col border-r border-border bg-surface",
                        // The rail is a drawer on a phone: a 15rem rail beside a
                        // 4rem list helps nobody.
                        railOpen ? "absolute inset-y-0 left-0 z-30 flex" : "hidden md:flex"
                    )}
                >
                    <div className="flex items-center gap-2 px-3 py-3">
                        <Button
                            className="w-full justify-start gap-2"
                            onClick={() => {
                                setComposing({});
                                setRailOpen(false);
                            }}
                        >
                            <PenLine className="size-4 shrink-0" aria-hidden />
                            Write
                        </Button>
                    </div>
                    <MailRail onNavigate={() => setRailOpen(false)} />
                </aside>

                {railOpen ? (
                    <button
                        type="button"
                        aria-label="Close the mailbox list"
                        className="absolute inset-0 z-20 bg-black/40 md:hidden"
                        onClick={() => setRailOpen(false)}
                    />
                ) : null}

                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Mailboxes"
                            title="Mailboxes"
                            onClick={() => setRailOpen(true)}
                        >
                            <Menu className="size-4 shrink-0" aria-hidden />
                        </Button>
                        {reading ? (
                            <Link
                                href={pathname.startsWith("/mail/t/") ? "/mail" : pathname}
                                className="text-[13px] text-muted-foreground"
                            >
                                Back to the list
                            </Link>
                        ) : null}
                    </div>
                    <div
                        className={cn(
                            "min-h-0 flex-1",
                            inSettings ? "overflow-y-auto" : "overflow-hidden"
                        )}
                    >
                        {children}
                    </div>
                </div>
                {/* The composer floats over whatever is being read, so somebody
                    can look something up in the conversation behind it while
                    they write. Rendered here rather than per screen, so opening
                    it from a rail button and from a Reply are the same thing. */}
                <Composer />
                {asking ? (
                    <FolderRoleDialog
                        missing={asking.missing}
                        onClose={() => setAsking(null)}
                        onSettled={asking.retry}
                    />
                ) : null}
            </div>
        </MailContext.Provider>
    );
}
