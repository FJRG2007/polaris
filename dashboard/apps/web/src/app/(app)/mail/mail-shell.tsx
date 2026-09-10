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
import { Composer } from "./composer";
import { MailRail } from "./mail-rail";
import { MAIL_PALETTE } from "./palette";
import { Button, PAGE_BLEED } from "@polaris/ui";
import { useMailStream } from "./use-mail-stream";
import { Menu, PenLine, Plus } from "lucide-react";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MailIdentityView, MailLabelView } from "@/lib/mailbox/labels";
import { FolderRoleDialog, type MissingFolderRole } from "./folder-role-dialog";
import {
    useRef,
    useMemo,
    useState,
    useEffect,
    useContext,
    useCallback,
    createContext,
    type ReactNode
} from "react";

export interface MailContextValue {
    readonly accounts: readonly MailAccountView[];
    readonly folders: readonly MailFolderView[];
    readonly labels: readonly MailLabelView[];
    /** The addresses each mailbox may send as, keyed by mailbox. */
    readonly identities: Readonly<Record<string, readonly MailIdentityView[]>>;
    readonly unread: { total: number; byAccount: Record<string, number> };
    readonly viewerName: string;
    /** Which shelf is on screen: "personal", or the organization's id. Part of
     *  every client-side cache key, so one shelf's list is never drawn on the
     *  other's. */
    readonly shelf: string;
    /** Pull everything the server drew again. The answer to every live frame:
     *  one small query, against teaching the client to apply every kind of
     *  change to a shape the server already knows how to build. */
    readonly refresh: () => void;
    /**
     * Pull the lists again without touching the router.
     *
     * The other half of `refresh`, on its own, and it exists for one moment:
     * filing the conversation that is open. Closing the pane is a navigation,
     * and asking the router to refresh in the same breath is a second fetch
     * racing it - the navigation is the one that loses, which used to leave the
     * address still naming a conversation that had been deleted. So that path
     * reloads the data and lets the navigation be the navigation.
     */
    readonly reloadLists: () => void;
    /**
     * How many times that has been asked for.
     *
     * The rail and the counts are the server's and come back with
     * `router.refresh()`; the list and the conversation are fetched by the
     * browser and would not notice it. So a refresh is also a number, and the
     * reads that are not the router's watch it - which is the whole of how a
     * message arriving reaches a list nobody re-rendered.
     */
    readonly revision: number;
    /**
     * Take unread off a folder and a mailbox now, before the server says so.
     *
     * The numbers in the rail come from the server, and the server is on the far
     * side of a click that also has to reach somebody else's IMAP host. Marking
     * a message read and watching "Inbox 3" stay at three is the screen telling
     * the reader their click did nothing - and the row beside it has already
     * gone un-bold, so they can see the two disagree.
     *
     * Laid over the server's own figures and dropped the moment those figures
     * move, which is the same shape the list's row overlay has and for the same
     * reason: this is what somebody just did, not what is true.
     */
    readonly nudgeUnread: (entries: readonly UnreadNudge[]) => void;
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

/** One folder with fewer (or more) unread than the server last said. */
export interface UnreadNudge {
    readonly folderId: string;
    /** Negative for mail that stopped being unread. */
    readonly by: number;
}

/** What the composer opens with. Null closes it. */
export interface ComposerSeed {
    readonly accountId?: string;
    readonly to?: readonly { name: string; address: string }[];
    readonly cc?: readonly { name: string; address: string }[];
    /** Only ever from a `mailto:` link: nothing Polaris starts itself is blind. */
    readonly bcc?: readonly { name: string; address: string }[];
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
const ACCOUNT_COLORS = MAIL_PALETTE.map((swatch) => swatch.hex);

function colorFor(seed: string): string {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) | 0;
    }
    return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0]!;
}

/** How long the live channel is allowed to settle before the screen is asked
 *  for again. One action lands as several frames, and each of them used to be a
 *  fetch of the whole page. */
const STREAM_SETTLE_MS = 400;

/** Where somebody with no mailbox is sent when they ask to write: the connect
 *  dialog, already open. */
export const CONNECT_MAILBOX_HREF = "/mail/settings/accounts?connect=1";

export function MailShell({
    accounts,
    folders,
    labels,
    identities,
    unread,
    viewerName,
    shelf,
    children
}: {
    accounts: MailAccountView[];
    folders: MailFolderView[];
    labels: MailLabelView[];
    identities: Record<string, MailIdentityView[]>;
    unread: { total: number; byAccount: Record<string, number> };
    viewerName: string;
    shelf: string;
    children: ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const [composing, setComposing] = useState<ComposerSeed | null>(null);
    const [railOpen, setRailOpen] = useState(false);
    const [asking, setAsking] = useState<{ missing: MissingFolderRole; retry: () => void } | null>(
        null
    );

    /**
     * What this browser has already done that the server's counts predate.
     *
     * Keyed by folder and by mailbox, so one map covers both numbers the rail
     * draws. Dropped the instant the server's own figures move rather than after
     * a wait: the signature below is the counts themselves, so the overlay lives
     * exactly as long as the disagreement it exists to cover, and never doubles
     * a change that has already landed.
     */
    const [drift, setDrift] = useState<Record<string, number>>({});
    const truth = useMemo(
        () =>
            `${unread.total}|${folders.map((folder) => `${folder.id}:${folder.unread}`).join(",")}`,
        [unread, folders]
    );
    useEffect(() => {
        setDrift((held) => (Object.keys(held).length === 0 ? held : {}));
    }, [truth]);

    const nudgeUnread = useCallback(
        (entries: readonly UnreadNudge[]) => {
            const wanted = entries.filter((entry) => entry.by !== 0);
            if (wanted.length === 0) return;
            setDrift((held) => {
                const next = { ...held };
                for (const entry of wanted) {
                    const folder = folders.find((one) => one.id === entry.folderId);
                    if (!folder) continue;
                    next[`f:${folder.id}`] = (next[`f:${folder.id}`] ?? 0) + entry.by;
                    // The badge on the mailbox counts inboxes and nothing else,
                    // so mail read in Archive moves the folder's number and not
                    // that one. Decided here rather than by the caller: the
                    // screen knows which folder a row was in, not what that
                    // folder means.
                    if (folder.role === "inbox") {
                        next[`a:${folder.accountId}`] =
                            (next[`a:${folder.accountId}`] ?? 0) + entry.by;
                    }
                }
                return next;
            });
        },
        [folders]
    );

    /** The counts as the reader should see them: the server's, with what they
     *  have just done laid over, and never below nothing. */
    const shownFolders = useMemo(
        () =>
            Object.keys(drift).length === 0
                ? folders
                : folders.map((folder) => {
                      const by = drift[`f:${folder.id}`] ?? 0;
                      return by === 0
                          ? folder
                          : { ...folder, unread: Math.max(0, folder.unread + by) };
                  }),
        [folders, drift]
    );
    const shownUnread = useMemo(() => {
        if (Object.keys(drift).length === 0) return unread;
        const byAccount: Record<string, number> = {};
        let total = 0;
        for (const account of accounts) {
            const count = Math.max(
                0,
                (unread.byAccount[account.id] ?? 0) + (drift[`a:${account.id}`] ?? 0)
            );
            if (count > 0) byAccount[account.id] = count;
            total += count;
        }
        return { total, byAccount };
    }, [accounts, unread, drift]);

    const [revision, setRevision] = useState(0);
    const reloadLists = useCallback(() => setRevision((count) => count + 1), []);
    const refresh = useCallback(() => {
        // Both halves of the screen, which no longer come from the same place.
        reloadLists();
        router.refresh();
    }, [reloadLists, router]);

    /**
     * The live channel's own refreshes, coalesced.
     *
     * One delete is not one frame. Moving a message changes a mailbox, the sync
     * that follows changes it again, and the server says so each time - so a
     * single action arrives here as a burst, and each of those was asking the
     * router to fetch the whole screen again. A router that is fetching is a
     * router that defers what somebody clicks next, which is what made a mailbox
     * feel dead until it was reloaded.
     *
     * A short pause after the last frame is enough: nothing here is watching a
     * clock, and a screen that redraws a beat after the mail moved is what a
     * mailbox has always looked like.
     */
    const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onFrame = useCallback(() => {
        if (settling.current) clearTimeout(settling.current);
        settling.current = setTimeout(() => {
            settling.current = null;
            refresh();
        }, STREAM_SETTLE_MS);
    }, [refresh]);
    useEffect(
        () => () => {
            if (settling.current) clearTimeout(settling.current);
        },
        []
    );
    useMailStream(onFrame);

    /**
     * Another shelf: personal mail for an organization's, or back.
     *
     * The rail is the server's and follows on its own. The list and the open
     * conversation are the browser's, and neither had any reason to ask again -
     * so the list kept the other shelf's mail and the conversation stayed open on
     * a mailbox that is not on this shelf. The list is asked for again, and a
     * conversation that was open is closed: it belongs to the shelf that was left.
     */
    const shownShelf = useRef(shelf);
    useEffect(() => {
        if (shownShelf.current === shelf) return;
        shownShelf.current = shelf;
        reloadLists();
        if (search.get("open") || pathname.startsWith("/mail/t/")) {
            router.replace("/mail", { scroll: false });
        }
    }, [shelf, reloadLists, router, search, pathname]);

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

    /**
     * Open the composer, or say what is missing first.
     *
     * A message needs a mailbox to leave from. With none connected the composer
     * would open with an empty From and fail only on Send, so every way in -
     * Write, the keyboard shortcut, a `mailto:` link - goes to connecting one
     * instead. Closing is always allowed.
     */
    const hasMailbox = accounts.length > 0;
    const openComposer = useCallback(
        (draft: ComposerSeed | null) => {
            if (draft && !hasMailbox) {
                router.push(CONNECT_MAILBOX_HREF);
                return;
            }
            setComposing(draft);
        },
        [hasMailbox, router]
    );

    const value = useMemo<MailContextValue>(
        () => ({
            accounts,
            folders: shownFolders,
            labels,
            identities,
            unread: shownUnread,
            viewerName,
            shelf,
            refresh,
            reloadLists,
            revision,
            nudgeUnread,
            accountColor,
            composing,
            openComposer,
            askFolderRole
        }),
        [
            accounts,
            shownFolders,
            labels,
            identities,
            shownUnread,
            viewerName,
            shelf,
            refresh,
            reloadLists,
            revision,
            nudgeUnread,
            accountColor,
            composing,
            openComposer,
            askFolderRole
        ]
    );

    // Inside a conversation on a phone the list steps aside, which is why this
    // decides a class rather than a render: the list keeps its scroll position
    // and its selection while it is off screen.
    const reading = Boolean(search.get("open")) || pathname.startsWith("/mail/t/");
    const inSettings = pathname.startsWith("/mail/settings");

    return (
        <MailContext.Provider value={value}>
            {/* No `h-full` here, and that is the whole of why this app has one
                scrollbar rather than two. PAGE_BLEED already fixes the height to
                what is left of the window; `h-full` is `height: 100%` of a
                parent that has no height of its own, which resolves to auto - so
                the app grew to the height of its own content and the PAGE
                scrolled behind the list that was supposed to be doing it.

                Two Tailwind classes for one property do not resolve by the order
                they are written in the attribute, which is what makes this
                invisible in review: `cn` merges them and the later definition
                wins whatever the author meant. */}
            <div className={cn(PAGE_BLEED, "flex min-h-0 overflow-hidden")}>
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
                                openComposer({});
                                setRailOpen(false);
                            }}
                        >
                            {hasMailbox ? (
                                <PenLine className="size-4 shrink-0" aria-hidden />
                            ) : (
                                <Plus className="size-4 shrink-0" aria-hidden />
                            )}
                            {hasMailbox ? "Write" : "Connect a mailbox"}
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

                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                            inSettings ? "overflow-y-auto overscroll-contain" : "overflow-hidden"
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
