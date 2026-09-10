"use client";

/**
 * The rail: every mailbox this person has, and every way into them.
 *
 * Built around one decision. **The merged views come first.** Somebody with
 * three mailboxes nearly always wants one inbox holding all three, and having to
 * visit each in turn is the thing that makes people keep three browser tabs open
 * instead. So the top of the rail is Inbox, Starred, Snoozed, Drafts, Sent,
 * Archive, Spam and Trash, each spanning every mailbox that has not been taken
 * out of the merged views.
 *
 * Under that, the mailboxes themselves, each with its own colour and its own
 * unread count, and each expanding to the folders that mailbox actually has on
 * its server - which is where somebody goes when they want that mailbox alone,
 * or a folder only it has.
 *
 * A mailbox that has stopped working says so here rather than by quietly
 * receiving nothing, because the rail is the only screen somebody is guaranteed
 * to be looking at.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { useMail } from "./mail-shell";
import { MAIL_PALETTE } from "./palette";
import { MAIL_DRAG_TYPE } from "./mail-actions";
import { useMailRailOpen } from "./use-mail-rail";
import { RefusedMailboxes } from "./refused-notice";
import { useCallback, useMemo, useState } from "react";
import { refusedMailboxHref } from "@/lib/mailbox/refusals";
import { moveToFolderAction, setFolderColorAction } from "./actions";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    useToast
} from "@polaris/ui";
import {
    Archive,
    AlertTriangle,
    BellOff,
    Bookmark,
    Bug,
    ChevronDown,
    ChevronRight,
    Clock,
    FileText,
    Inbox,
    Layers,
    Plus,
    SendHorizontal,
    Star,
    Tag,
    Trash2,
    type LucideIcon
} from "lucide-react";

/**
 * What each kind of folder is drawn as.
 *
 * The reading is `core.folderLook`, which takes the server's own answer when it
 * gave one and the folder's name in six languages when it did not - so a mailbox
 * in Spanish gets a bin for Papelera rather than the same grey stack of paper
 * twenty times. This half is only the picture that goes with each answer.
 */
const FOLDER_ICONS: Record<core.FolderLook, LucideIcon> = {
    inbox: Inbox,
    drafts: FileText,
    sent: SendHorizontal,
    archive: Archive,
    junk: Bug,
    trash: Trash2,
    starred: Star,
    snoozed: Clock,
    important: Bookmark,
    notes: FileText,
    outbox: SendHorizontal,
    folder: Layers
};

/** The colours a folder can be given: the same eight a mailbox can. */
const FOLDER_COLORS = MAIL_PALETTE;

/** The merged views, in the order a mail client is read in. */
const MERGED: readonly { label: string; href: string; icon: LucideIcon; role?: string }[] = [
    { label: "Inbox", href: "/mail", icon: Inbox, role: "inbox" },
    { label: "Starred", href: "/mail/starred", icon: Star },
    { label: "Important", href: "/mail/important", icon: Bookmark },
    { label: "Snoozed", href: "/mail/snoozed", icon: Clock },
    { label: "Drafts", href: "/mail/drafts", icon: FileText, role: "drafts" },
    { label: "Sent", href: "/mail/sent", icon: SendHorizontal, role: "sent" },
    { label: "Archive", href: "/mail/archive", icon: Archive, role: "archive" },
    { label: "Spam", href: "/mail/junk", icon: Bug, role: "junk" },
    { label: "Trash", href: "/mail/trash", icon: Trash2, role: "trash" },
    // Last, and not a folder: it is the one entry here that lists senders rather
    // than mail. It sits in the rail all the same, because the way out of a
    // mailing list is only ever found by somebody who went looking for it.
    { label: "Subscriptions", href: "/mail/subscriptions", icon: BellOff }
];

export function MailRail({ onNavigate }: { onNavigate?: () => void }) {
    const { accounts, folders, labels, unread } = useMail();
    const pathname = usePathname();
    const search = useSearchParams();
    const router = useRouter();
    const toast = useToast();
    // Remembered for this browser rather than held for this mount - see
    // `use-mail-rail`. It closed on every reload, and on every navigation that
    // remounted the rail. The mailboxes go in so what is remembered can be
    // measured against the ones that are still connected.
    const accountIds = useMemo(() => accounts.map((account) => account.id), [accounts]);
    const { open: expanded, toggle: toggleAccount } = useMailRailOpen(accountIds);

    /**
     * File what was dragged into a folder.
     *
     * The server is told which messages and which folder and decides the rest:
     * both are looked up against the person asking, so a drag can only ever move
     * their own mail into their own folder.
     */
    /** Give a folder a colour, or take it off. The rail is the server's, so the
     *  answer arrives with the refresh rather than being patched in - one small
     *  write and one small re-render. */
    const colour = useCallback(
        async (folderId: string, hex: string) => {
            const outcome = await setFolderColorAction(folderId, hex);
            const said = refusalOf(outcome);
            if (said) toast.show({ title: said });
            else router.refresh();
        },
        [router, toast]
    );

    const fileInto = useCallback(
        async (folderId: string, name: string, messageIds: string[]) => {
            if (messageIds.length === 0) return;
            const outcome = await moveToFolderAction({ folderId, messageIds });
            const said = refusalOf(outcome);
            if (said) {
                toast.show({ title: said });
                return;
            }
            toast.show({
                title:
                    messageIds.length === 1
                        ? `Moved to ${name}.`
                        : `${messageIds.length} moved to ${name}.`
            });
            router.refresh();
        },
        [router, toast]
    );

    // The mailboxes that feed the merged views. One taken out of them still has
    // its own entry below; it just stops adding to the counts above.
    const merged = accounts.filter((account) => account.unified);
    const mergedUnread = merged.reduce(
        (total, account) => total + (unread.byAccount[account.id] ?? 0),
        0
    );

    return (
        <nav
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
            aria-label="Mailboxes"
        >
            {/* Above everything, because a mailbox that has stopped accepting
                its password is receiving nothing, and the rail is the one
                screen its owner is certain to be looking at. */}
            <RefusedMailboxes accounts={accounts} className="pt-2" onNavigate={onNavigate} />
            {accounts.length > 1 ? (
                <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                    All mailboxes
                </p>
            ) : null}
            <ul className="space-y-0.5">
                {MERGED.map((entry) => (
                    <li key={entry.href}>
                        <RailLink
                            href={entry.href}
                            label={entry.label}
                            icon={entry.icon}
                            count={entry.role === "inbox" ? mergedUnread : 0}
                            active={isActive(pathname, search, entry.href)}
                            onNavigate={onNavigate}
                        />
                    </li>
                ))}
            </ul>

            <div className="mt-4 flex items-center justify-between px-2 pb-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                    Mailboxes
                </p>
                <Link
                    href="/mail/settings/accounts"
                    className="text-foreground-subtle hover:text-foreground"
                    aria-label="Add a mailbox"
                    title="Add a mailbox"
                    onClick={onNavigate}
                >
                    <Plus className="size-3.5 shrink-0" aria-hidden />
                </Link>
            </div>

            {accounts.length === 0 ? (
                <Link
                    href="/mail/settings/accounts"
                    onClick={onNavigate}
                    className="mx-2 block rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground hover:border-foreground-subtle hover:text-foreground"
                >
                    Connect your first mailbox to start reading mail here.
                </Link>
            ) : null}

            <ul className="space-y-0.5">
                {accounts.map((account) => {
                    const open = expanded.has(account.id);
                    const own = folders.filter((folder) => folder.accountId === account.id);
                    return (
                        <li key={account.id}>
                            <div className="flex items-center">
                                <button
                                    type="button"
                                    className="flex size-6 shrink-0 items-center justify-center rounded text-foreground-subtle hover:text-foreground"
                                    aria-expanded={open}
                                    aria-label={
                                        open
                                            ? `Hide ${account.address} folders`
                                            : `Show ${account.address} folders`
                                    }
                                    onClick={() => toggleAccount(account.id)}
                                >
                                    {open ? (
                                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                                    ) : (
                                        <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                                    )}
                                </button>
                                <AccountLink
                                    account={account}
                                    count={unread.byAccount[account.id] ?? 0}
                                    onNavigate={onNavigate}
                                />
                            </div>
                            {open ? (
                                <ul className="ml-6 space-y-0.5 border-l border-border pl-2">
                                    {own.length === 0 ? (
                                        <li className="px-2 py-1.5 text-[12px] text-foreground-subtle">
                                            Nothing has been synced yet.
                                        </li>
                                    ) : null}
                                    {own.map((folder) => (
                                        <li key={folder.id}>
                                            <ContextMenu>
                                                <ContextMenuTrigger asChild>
                                                    <div>
                                                        <RailLink
                                                            href={`/mail/f/${folder.id}`}
                                                            label={folder.name}
                                                            icon={
                                                                FOLDER_ICONS[
                                                                    core.folderLook(
                                                                        folder.name,
                                                                        folder.role
                                                                    )
                                                                ]
                                                            }
                                                            color={folder.color}
                                                            count={folder.unread}
                                                            active={
                                                                pathname === `/mail/f/${folder.id}`
                                                            }
                                                            onNavigate={onNavigate}
                                                            onDropMail={(ids) =>
                                                                void fileInto(
                                                                    folder.id,
                                                                    folder.name,
                                                                    ids
                                                                )
                                                            }
                                                        />
                                                    </div>
                                                </ContextMenuTrigger>
                                                <ContextMenuContent>
                                                    <div className="flex gap-1 px-2 py-1.5">
                                                        {FOLDER_COLORS.map((swatch) => (
                                                            <button
                                                                key={swatch.hex}
                                                                type="button"
                                                                title={swatch.name}
                                                                aria-label={swatch.name}
                                                                onClick={() =>
                                                                    void colour(
                                                                        folder.id,
                                                                        swatch.hex
                                                                    )
                                                                }
                                                                className={cn(
                                                                    "size-4 shrink-0 rounded-full ring-offset-1 ring-offset-popover transition-shadow",
                                                                    folder.color === swatch.hex &&
                                                                        "ring-2 ring-foreground"
                                                                )}
                                                                style={{
                                                                    backgroundColor: swatch.hex
                                                                }}
                                                            />
                                                        ))}
                                                    </div>
                                                    <ContextMenuSeparator />
                                                    <ContextMenuItem
                                                        disabled={!folder.color}
                                                        onSelect={() => void colour(folder.id, "")}
                                                    >
                                                        No colour
                                                    </ContextMenuItem>
                                                </ContextMenuContent>
                                            </ContextMenu>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </li>
                    );
                })}
            </ul>

            {labels.length > 0 ? (
                <>
                    <p className="mt-4 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                        Labels
                    </p>
                    <ul className="space-y-0.5">
                        {labels.map((label) => (
                            <li key={label.id}>
                                <Link
                                    href={`/mail/label/${label.id}`}
                                    onClick={onNavigate}
                                    className={cn(
                                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                                        pathname === `/mail/label/${label.id}`
                                            ? "bg-card text-foreground"
                                            : "text-muted-foreground hover:bg-card hover:text-foreground"
                                    )}
                                >
                                    <Tag
                                        className="size-3.5 shrink-0"
                                        style={{ color: label.color }}
                                        aria-hidden
                                    />
                                    <span className="min-w-0 flex-1 truncate" title={label.name}>
                                        {label.name}
                                    </span>
                                    {label.count > 0 ? (
                                        <span className="text-[11px] tabular-nums text-foreground-subtle">
                                            {label.count}
                                        </span>
                                    ) : null}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </nav>
    );
}

/** Whether a merged view is the one being looked at. The inbox is the only one
 *  whose href is a prefix of the others, so it is matched exactly. */
function isActive(pathname: string, search: URLSearchParams, href: string): boolean {
    void search;
    return href === "/mail"
        ? pathname === "/mail" || pathname.startsWith("/mail/t/")
        : pathname === href;
}

function RailLink({
    href,
    label,
    icon: Icon,
    color,
    count,
    active,
    onNavigate,
    onDropMail
}: {
    href: string;
    label: string;
    icon: LucideIcon;
    /** A folder its owner gave a colour. The icon is tinted rather than replaced
     *  by a dot beside it: the row still says what kind of thing it is, and a
     *  coloured shape is what somebody scans a rail for. */
    color?: string;
    count: number;
    active: boolean;
    onNavigate?: () => void;
    /** Given on the entries mail can be filed into, which is a real folder and
     *  not a merged view: "everything starred" is not somewhere a message can
     *  be put. */
    onDropMail?: (messageIds: string[]) => void;
}) {
    const [over, setOver] = useState(false);
    return (
        <Link
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            onDragOver={
                onDropMail
                    ? (event) => {
                          if (!event.dataTransfer.types.includes(MAIL_DRAG_TYPE)) return;
                          // Both, and both matter: without the first the browser
                          // refuses the drop, without the second the cursor says
                          // "no" the whole way across.
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setOver(true);
                      }
                    : undefined
            }
            onDragLeave={onDropMail ? () => setOver(false) : undefined}
            onDrop={
                onDropMail
                    ? (event) => {
                          const carried = event.dataTransfer.getData(MAIL_DRAG_TYPE);
                          if (!carried) return;
                          event.preventDefault();
                          setOver(false);
                          onDropMail(carried.split(",").filter(Boolean));
                      }
                    : undefined
            }
            className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                active
                    ? "bg-card font-medium text-foreground"
                    : "text-muted-foreground hover:bg-card hover:text-foreground",
                // Said on the target rather than on the thing being dragged: the
                // question a reader has mid-drag is "will it land here".
                over && "ring-1 ring-inset ring-primary"
            )}
        >
            <Icon className="size-4 shrink-0" style={color ? { color } : undefined} aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
            </span>
            {count > 0 ? (
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
                    {count}
                </span>
            ) : null}
        </Link>
    );
}

/**
 * One mailbox.
 *
 * The dot is the mailbox's colour, and it is the same colour a row in a merged
 * list carries - that pairing is the whole reason somebody can read a merged
 * inbox without checking every row's account.
 *
 * A mailbox whose credential the server has started refusing says so here, in
 * the one place its owner is certain to be looking, and the whole row becomes
 * the way to fix it.
 */
function AccountLink({
    account,
    count,
    onNavigate
}: {
    account: ReturnType<typeof useMail>["accounts"][number];
    count: number;
    onNavigate?: () => void;
}) {
    const { accountColor } = useMail();
    const pathname = usePathname();
    const inbox = `/mail/a/${account.id}`;
    const broken = account.state === "auth" || account.state === "unreachable";

    return (
        <Link
            href={
                account.state === "auth"
                    ? refusedMailboxHref(account.id)
                    : broken
                      ? "/mail/settings/accounts"
                      : inbox
            }
            onClick={onNavigate}
            aria-current={pathname === inbox ? "page" : undefined}
            className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                pathname === inbox
                    ? "bg-card font-medium text-foreground"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
            )}
            title={broken ? whyBroken(account) : account.address}
        >
            <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: accountColor(account.id) }}
                aria-hidden
            />
            <span className="min-w-0 flex-1 truncate" title={account.label || account.address}>
                {account.label || account.address}
            </span>
            {broken ? (
                <AlertTriangle
                    className="size-3.5 shrink-0 text-danger"
                    aria-label={whyBroken(account)}
                />
            ) : count > 0 ? (
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
                    {count}
                </span>
            ) : null}
        </Link>
    );
}

function whyBroken(account: { state: string; auth: string }): string {
    if (account.state !== "auth") return "Polaris cannot reach this mail server.";
    return account.auth === "oauth"
        ? "This mailbox needs connecting again."
        : "This mailbox stopped accepting its password.";
}
