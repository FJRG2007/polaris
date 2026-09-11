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
import { z } from "zod";
import { cn } from "@polaris/ui";
import { Composer } from "./composer";
import { MailRail } from "./mail-rail";
import { MAIL_VIEWS } from "./views";
import { MAIL_PALETTE, coloursFor } from "./palette";
import { Button, PAGE_BLEED } from "@polaris/ui";
import { useMailStream } from "./use-mail-stream";
import { Menu, PenLine, Plus } from "lucide-react";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { useNudgeMailUnread } from "@/components/mail-unread";
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
    /**
     * Show a folder renamed, or gone, before the mail server has answered.
     *
     * `null` takes the overlay back, which is what a refusal does. Dropped by
     * itself the moment the server's own list moves, so nothing has to remember
     * to clear it after a success. A colour is Polaris' own rather than the mail
     * server's and still goes through here: the write is quick, the render that
     * shows it was not.
     */
    readonly patchFolder: (
        folderId: string,
        change: { name?: string; color?: string; gone?: boolean } | null
    ) => void;
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

/** How long the live channel is allowed to settle before the screen is asked
 *  for again. One action lands as several frames, and each of them used to be a
 *  fetch of the whole page. */
const STREAM_SETTLE_MS = 400;

/** Where the rail's mailboxes, folders and counts come from between renders. */
const RAIL_PATH = "/api/mail/rail";

/** The merged views, as addresses: `/mail/starred`, `/mail/sent` and the rest.
 *  Read off the same table the routes are built from, so a view added there is
 *  a list here without anybody saying so twice. */
const MAIL_VIEW_PATHS = new Set(Object.keys(MAIL_VIEWS).map((view) => `/mail/${view}`));

/**
 * What that answers, validated on arrival.
 *
 * A tab left open across a deploy is talking to a server that has moved on, and
 * a shape it does not understand has to leave the rail as it was rather than
 * blank it.
 */
const railSchema = z.object({
    accounts: z.array(z.custom<MailAccountView>()),
    folders: z.array(z.custom<MailFolderView>()),
    unread: z.object({ total: z.number(), byAccount: z.record(z.string(), z.number()) })
});

/** Where somebody with no mailbox is sent when they ask to write: the connect
 *  dialog, already open. */
export const CONNECT_MAILBOX_HREF = "/mail/settings/accounts?connect=1";

export function MailShell({
    accounts: sentAccounts,
    folders: sentFolders,
    labels,
    identities,
    unread: sentUnread,
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
    /**
     * The rail, as it stands rather than as the server last rendered it.
     *
     * Seeded from the layout - which is what makes the first paint right - and
     * moved after that by the live channel, which asks a small endpoint for
     * these three things alone. It used to be `router.refresh()`: a mailbox
     * syncing announces itself several times a minute, each announcement
     * re-rendered the whole signed-in frame and the page inside it, and a router
     * that is fetching defers what somebody clicks next. Links and buttons doing
     * nothing - or doing it a second later - for as long as Mail was open was
     * this, and nothing else.
     */
    const [rail, setRail] = useState({ accounts: sentAccounts, folders: sentFolders, unread: sentUnread });
    // The server has rendered again - a mailbox added, a label written, a shelf
    // switched - and what it says now is the truth this was standing in for.
    useEffect(() => {
        setRail({ accounts: sentAccounts, folders: sentFolders, unread: sentUnread });
    }, [sentAccounts, sentFolders, sentUnread]);
    const accounts = rail.accounts;
    const folders = rail.folders;
    const unread = rail.unread;
    const nudgeBadge = useNudgeMailUnread();
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
            // The badge outside Mail counts inboxes across every shelf, which is
            // the same question the mailbox badges here answer - so it moves on
            // the same deltas rather than waiting for the mail server to be told
            // and to announce it. See `useNudgeMailUnread`.
            nudgeBadge(
                wanted.reduce((sum, entry) => {
                    const folder = folders.find((one) => one.id === entry.folderId);
                    return folder?.role === "inbox" ? sum + entry.by : sum;
                }, 0)
            );
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
        [folders, nudgeBadge]
    );

    /**
     * What has just been done to a folder itself, before the server says so.
     *
     * The same overlay the counts have, for the same reason and exactly as long:
     * renaming a folder or throwing it away is a round trip to somebody else's
     * IMAP server, and a rail that goes on showing the old name - or the folder
     * that was just deleted - until that answers is a rail saying the press did
     * nothing. Both come back, with the reason, if the server refuses.
     */
    const [folderEdits, setFolderEdits] = useState<
        Record<string, { readonly name?: string; readonly color?: string; readonly gone?: boolean }>
    >({});
    const patchFolder = useCallback(
        (folderId: string, change: { name?: string; color?: string; gone?: boolean } | null) => {
            setFolderEdits((held) => {
                if (change === null) {
                    if (!held[folderId]) return held;
                    const next = { ...held };
                    delete next[folderId];
                    return next;
                }
                return { ...held, [folderId]: { ...held[folderId], ...change } };
            });
        },
        []
    );
    // The server's own list has moved, which is the end of standing in for it.
    const folderTruth = useMemo(
        () => folders.map((folder) => `${folder.id}:${folder.name}`).join(","),
        [folders]
    );
    useEffect(() => {
        setFolderEdits((held) => (Object.keys(held).length === 0 ? held : {}));
    }, [folderTruth]);

    /** The counts as the reader should see them: the server's, with what they
     *  have just done laid over, and never below nothing. */
    const shownFolders = useMemo(() => {
        const counted =
            Object.keys(drift).length === 0
                ? folders
                : folders.map((folder) => {
                      const by = drift[`f:${folder.id}`] ?? 0;
                      return by === 0
                          ? folder
                          : { ...folder, unread: Math.max(0, folder.unread + by) };
                  });
        if (Object.keys(folderEdits).length === 0) return counted;
        return counted.flatMap((folder) => {
            const over = folderEdits[folder.id];
            if (!over) return [folder];
            if (over.gone) return [];
            return [
                {
                    ...folder,
                    ...(over.name ? { name: over.name } : {}),
                    ...(over.color === undefined ? {} : { color: over.color })
                }
            ];
        });
    }, [folders, drift, folderEdits]);
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

    /**
     * Pull the rail's own three things, and nothing else.
     *
     * What a live frame costs now. The alternative was `router.refresh()`, which
     * re-runs the signed-in frame - every badge, every count, the presence, the
     * notifications - and then this layout and the page inside it, to move a
     * number beside a folder.
     */
    const pullRail = useCallback(() => {
        void fetch(RAIL_PATH, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const parsed = railSchema.safeParse(body);
                if (parsed.success) setRail(parsed.data);
            })
            .catch(() => {
                // The rail stays as it is, which is the last thing the server
                // actually said. The next frame asks again.
            });
    }, []);

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
            // The lists this tab fetches for itself, and the rail. Deliberately
            // NOT the router: see `rail`. Everything a frame can change is in
            // one of those two, and the things that are not - a label written, a
            // mailbox added - are actions whose own handler refreshes.
            reloadLists();
            pullRail();
        }, STREAM_SETTLE_MS);
    }, [pullRail, reloadLists]);
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

    // Worked out for the whole rail at once, because "which colour is free" is a
    // question about the others - see `coloursFor`.
    const colours = useMemo(() => coloursFor(accounts), [accounts]);
    const accountColor = useCallback(
        (accountId: string) => colours[accountId] ?? MAIL_PALETTE[0]!.hex,
        [colours]
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
            patchFolder,
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
            patchFolder,
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
    /**
     * Whether what is inside scrolls itself, or has to be scrolled.
     *
     * A list of conversations owns its own scrollbar: the rows move under a
     * toolbar that stays. So the area holding one must not have a scrollbar of
     * its own, or there are two. Everything else here is an ordinary page,
     * taller than the window, and this area is the only thing that can move it.
     *
     * Decided by what IS a list rather than by what is not, which is the bug
     * this had: it asked whether the path was under `/mail/settings`, so
     * Subscriptions - a page of every sender somebody could leave, easily
     * hundreds of rows - was cut off at the bottom of the window with no way to
     * reach the rest of it. A page added under /mail tomorrow scrolls without
     * anybody remembering to come here.
     */
    const listing =
        pathname === "/mail" ||
        pathname.startsWith("/mail/t/") ||
        pathname.startsWith("/mail/a/") ||
        pathname.startsWith("/mail/f/") ||
        pathname.startsWith("/mail/label/") ||
        pathname === "/mail/drafts" ||
        MAIL_VIEW_PATHS.has(pathname);

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
                            listing ? "overflow-hidden" : "overflow-y-auto overscroll-contain"
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
