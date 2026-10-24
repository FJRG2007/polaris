"use client";

/**
 * Sharing Polar chats, the way ChatGPT shares its own: a read-only snapshot,
 * by public link or sent to Polaris people, updated to now on request and
 * taken back at any time.
 *
 * - `PolarShareDialog` - one chat's link (create, copy, update, delete) and the
 *   people it was sent to (send with a note, take back from one). Opened from
 *   an answer's row, the snapshot it makes or updates ends at that answer.
 * - `SharedWithYou` - the sidebar section listing chats other people sent you.
 * - `SharedLinksDialog` - every chat you share, to open, copy or stop sharing.
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
    LinkAdvancedFields,
    EMPTY_LINK_ADVANCED,
    linkLimits,
    linkExpiryDay,
    linkGuardFields,
    type LinkAdvancedValue
} from "@/components/link-advanced-fields";
import { Link2, MessageSquareShare, Share2, Trash2, X } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    CopyIcon,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea,
    useCopied,
    useToast
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import type {
    OwnedPolarShare,
    PolarShareLink,
    PolarSharedWithMe,
    PolarShareRecipientView,
    PolarThreadRow
} from "@/lib/polar/shared";

/** The same bounds the server keeps (`lib/polar/share.ts`), said here so the
 *  form never offers what the server refuses. */
const NOTE_MAX = 500;
const SEND_MOST = 20;

async function findPeople(query: string) {
    const response = await fetch(`/api/polar/people?q=${encodeURIComponent(query)}`).catch(
        () => null
    );
    if (!response?.ok) return { results: [] };
    return (await response.json()) as {
        results?: { id: string; name: string }[];
        withheld?: number;
    };
}

function IconAction({
    label,
    onClick,
    disabled,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

/** One chat's link and the people it was sent to. `upTo` ends the snapshot at
 *  that answer; without it the link keeps the end point it already had. */
export function PolarShareDialog({
    row,
    upTo,
    onClose
}: {
    row: Pick<PolarThreadRow, "id">;
    upTo?: string | null;
    onClose: () => void;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const { copied, copy } = useCopied();
    const [link, setLinkState] = useState<PolarShareLink | null | undefined>(undefined);
    const [advanced, setAdvanced] = useState<LinkAdvancedValue>(EMPTY_LINK_ADVANCED);
    /** Every new state of the link reseeds the Advanced section from it. */
    const setLink = useCallback((next: PolarShareLink | null | undefined) => {
        setLinkState(next);
        setAdvanced(advancedOf(next ?? null));
    }, []);
    const [people, setPeople] = useState<PolarShareRecipientView[] | null>(null);
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [note, setNote] = useState("");
    const [working, setWorking] = useState(false);

    useEffect(() => {
        let live = true;
        fetch(`/api/polar/threads/${row.id}/share`)
            .then((response) => (response.ok ? response.json() : Promise.reject()))
            .then((data: { link: PolarShareLink | null }) => {
                if (live) setLink(data.link ?? null);
            })
            .catch(() => {
                if (live) setLink(null);
            });
        fetch(`/api/polar/threads/${row.id}/share/people`)
            .then((response) => (response.ok ? response.json() : Promise.reject()))
            .then((data: { people?: PolarShareRecipientView[] }) => {
                if (live) setPeople(data.people ?? []);
            })
            .catch(() => {
                if (live) setPeople([]);
            });
        return () => {
            live = false;
        };
    }, [row.id]);

    const change = async (method: "POST" | "DELETE") => {
        setWorking(true);
        const response = await fetch(`/api/polar/threads/${row.id}/share`, {
            method,
            ...(method === "POST" && upTo
                ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ upTo })
                  }
                : {})
        }).catch(() => null);
        setWorking(false);
        if (!response?.ok) {
            toast.show({ title: t("history.shareFailed") });
            return;
        }
        if (method === "DELETE") {
            setLink(null);
            return;
        }
        const data = (await response.json()) as { link: PolarShareLink };
        setLink(data.link);
        if (await copy(data.link.url)) toast.show({ title: t("history.shareCopied") });
    };

    // A typed password is always a change: a stored one cannot be read back.
    const limitsChanged =
        Boolean(link) &&
        (advanced.password !== "" ||
            JSON.stringify(advanced) !== JSON.stringify(advancedOf(link ?? null)));

    const saveLimits = async () => {
        setWorking(true);
        const response = await fetch(`/api/polar/threads/${row.id}/share`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                limits: linkLimits(advanced)
            })
        }).catch(() => null);
        setWorking(false);
        if (!response?.ok) {
            toast.show({ title: t("history.shareFailed") });
            return;
        }
        setLink(((await response.json()) as { link: PolarShareLink }).link);
    };

    const send = async () => {
        setWorking(true);
        const response = await fetch(`/api/polar/threads/${row.id}/share/people`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                userIds: picked.map((person) => person.id),
                note: note.trim() || null,
                ...(upTo ? { upTo } : {})
            })
        }).catch(() => null);
        setWorking(false);
        if (!response?.ok) {
            const error = response
                ? ((await response.json().catch(() => ({}))) as { error?: string }).error
                : undefined;
            toast.show({
                title: t(
                    error === "unavailable"
                        ? "sharing.unavailable"
                        : error === "too_many"
                          ? "sharing.tooMany"
                          : "sharing.sendFailed"
                )
            });
            return;
        }
        const data = (await response.json()) as { people: PolarShareRecipientView[] };
        setPeople(data.people);
        setPicked([]);
        setNote("");
        toast.show({ title: t("sharing.sent") });
    };

    const takeBack = async (person: PolarShareRecipientView) => {
        const before = people;
        // Gone from the list at once; back if the server refuses.
        setPeople((current) => current?.filter((entry) => entry.userId !== person.userId) ?? null);
        const response = await fetch(
            `/api/polar/threads/${row.id}/share/people?user=${encodeURIComponent(person.userId)}`,
            { method: "DELETE" }
        ).catch(() => null);
        if (!response?.ok) {
            setPeople(before);
            toast.show({ title: t("history.shareFailed") });
            return;
        }
        toast.show({ title: t("sharing.removed") });
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-h-[min(40rem,90dvh)] max-w-lg flex-col gap-4">
                <DialogHeader>
                    <DialogTitle>{t("history.shareTitle")}</DialogTitle>
                    <DialogDescription>
                        {t(upTo ? "sharing.upToIntro" : "history.shareIntro")}
                    </DialogDescription>
                </DialogHeader>
                <div className="-mx-1 min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-1">
                    <section className="space-y-2">
                        <h3 id="polar-share-link" className="text-sm font-medium text-foreground">
                            {t("sharing.linkSection")}
                        </h3>
                        {link === undefined ? (
                            <div className="h-9 rounded bg-muted motion-safe:animate-pulse" />
                        ) : link ? (
                            <div className="space-y-1">
                                <div className="flex min-w-0 items-center gap-2">
                                    <Input
                                        readOnly
                                        value={link.url}
                                        aria-label={t("history.shareLink")}
                                        onFocus={(event) => event.currentTarget.select()}
                                        className="min-w-0 flex-1"
                                    />
                                    <IconAction
                                        label={t("history.shareCopy")}
                                        onClick={() =>
                                            void copy(link.url).then((done) =>
                                                done
                                                    ? toast.show({
                                                          title: t("history.shareCopied")
                                                      })
                                                    : null
                                            )
                                        }
                                    >
                                        <CopyIcon copied={copied} className="size-4" />
                                    </IconAction>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t("history.shareUpdated", {
                                        date: new Date(link.sharedAt).toLocaleString(undefined, {
                                            dateStyle: "medium",
                                            timeStyle: "short"
                                        })
                                    })}
                                </p>
                                <LinkAdvancedFields
                                    value={advanced}
                                    onChange={setAdvanced}
                                    passwordSet={link.hasPassword}
                                    clearablePassword
                                    idPrefix="polar-share"
                                />
                                {limitsChanged ? (
                                    <div className="flex justify-end">
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={working}
                                            onClick={() => void saveLimits()}
                                        >
                                            {t("sharing.saveLimits")}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        <div className="flex flex-wrap justify-end gap-2">
                            {link ? (
                                <>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={working}
                                        onClick={() => void change("DELETE")}
                                        className="text-danger"
                                    >
                                        <Trash2 className="size-4" />
                                        {t("history.shareRevoke")}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        disabled={working}
                                        onClick={() => void change("POST")}
                                    >
                                        {t("history.shareUpdate")}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    disabled={working || link === undefined}
                                    onClick={() => void change("POST")}
                                >
                                    <Share2 className="size-4" />
                                    {t("history.shareCreate")}
                                </Button>
                            )}
                        </div>
                    </section>
                    <section className="space-y-2">
                        <div>
                            <h3
                                id="polar-share-people"
                                className="text-sm font-medium text-foreground"
                            >
                                {t("sharing.peopleSection")}
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                {t("sharing.peopleHint")}
                            </p>
                        </div>
                        <PeoplePicker
                            picked={picked}
                            onChange={setPicked}
                            exclude={(people ?? []).map((person) => person.userId)}
                            max={SEND_MOST}
                            label={t("sharing.peopleLabel")}
                            search={findPeople}
                        />
                        {picked.length > 0 ? (
                            <>
                                <Textarea
                                    value={note}
                                    maxLength={NOTE_MAX}
                                    rows={2}
                                    aria-label={t("sharing.note")}
                                    placeholder={t("sharing.notePlaceholder")}
                                    onChange={(event) => setNote(event.target.value)}
                                />
                                <div className="flex justify-end">
                                    <Button
                                        type="button"
                                        disabled={working}
                                        onClick={() => void send()}
                                    >
                                        <MessageSquareShare className="size-4" />
                                        {t("sharing.send")}
                                    </Button>
                                </div>
                            </>
                        ) : null}
                        {people && people.length > 0 ? (
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-foreground-subtle">
                                    {t("sharing.recipients")}
                                </p>
                                <ul className="space-y-0.5">
                                    {people.map((person) => (
                                        <li
                                            key={person.userId}
                                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-card-hover"
                                        >
                                            <span
                                                className="min-w-0 flex-1 truncate text-sm text-foreground"
                                                title={person.name ?? t("sharing.somebody")}
                                            >
                                                {person.name ?? t("sharing.somebody")}
                                            </span>
                                            <IconAction
                                                label={t("sharing.remove", {
                                                    name: person.name ?? t("sharing.somebody")
                                                })}
                                                onClick={() => void takeBack(person)}
                                            >
                                                <X className="size-4" />
                                            </IconAction>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The chats other people sent you, under their own header in the sidebar. */
export function SharedWithYou({ rowClass }: { rowClass: string }) {
    const t = useTranslations("polar");
    const [rows, setRows] = useState<PolarSharedWithMe[]>([]);

    useEffect(() => {
        let live = true;
        fetch("/api/polar/shared")
            .then((response) => (response.ok ? response.json() : Promise.reject()))
            .then((data: { shared?: PolarSharedWithMe[] }) => {
                if (live && Array.isArray(data.shared)) setRows(data.shared);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    if (rows.length === 0) return null;
    return (
        <div role="group" aria-labelledby="polar-shared-with-you" className="pt-3">
            <p
                id="polar-shared-with-you"
                className="truncate px-2 pb-1 text-xs font-medium text-foreground-subtle"
            >
                {t("sharing.sharedWithYou")}
            </p>
            {rows.map((row) => (
                <Link
                    key={row.id}
                    href={`/polar/shared/${row.id}`}
                    title={`${row.title} - ${t("sharing.from", { name: row.from ?? t("sharing.somebody") })}`}
                    className={rowClass}
                >
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                        {row.from ?? t("sharing.somebody")}
                    </span>
                </Link>
            ))}
        </div>
    );
}

/** Every chat this person shares: open it, copy its link, or stop sharing. */
export function SharedLinksDialog({
    onClose,
    onOpen
}: {
    onClose: () => void;
    onOpen: (threadId: string) => void;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const { copy } = useCopied();
    const [shares, setShares] = useState<OwnedPolarShare[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [stopping, setStopping] = useState<OwnedPolarShare | null>(null);

    const load = useCallback(() => {
        setFailed(false);
        fetch("/api/polar/shares")
            .then((response) => (response.ok ? response.json() : Promise.reject()))
            .then((data: { shares?: OwnedPolarShare[] }) => setShares(data.shares ?? []))
            .catch(() => setFailed(true));
    }, []);
    useEffect(load, [load]);

    const stop = async (share: OwnedPolarShare) => {
        const before = shares;
        setShares(
            (current) => current?.filter((entry) => entry.threadId !== share.threadId) ?? null
        );
        const response = await fetch(`/api/polar/threads/${share.threadId}/share?everyone=1`, {
            method: "DELETE"
        }).catch(() => null);
        if (!response?.ok) {
            setShares(before);
            toast.show({ title: t("history.shareFailed") });
        }
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-h-[min(36rem,85dvh)] max-w-lg flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t("sharing.links")}</DialogTitle>
                    <DialogDescription>{t("sharing.linksIntro")}</DialogDescription>
                </DialogHeader>
                <div className="-mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {failed ? (
                        <p className="px-2 py-1.5 text-sm text-danger">
                            {t("sharing.linksFailed")}
                        </p>
                    ) : shares === null ? (
                        <div className="space-y-2 p-2">
                            {[0, 1, 2].map((key) => (
                                <div
                                    key={key}
                                    className="h-8 rounded bg-muted motion-safe:animate-pulse"
                                />
                            ))}
                        </div>
                    ) : shares.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t("sharing.linksEmpty")}
                        </p>
                    ) : (
                        <ul>
                            {shares.map((share) => (
                                <li
                                    key={share.threadId}
                                    className="flex min-w-0 items-center gap-1 rounded-md hover:bg-card-hover"
                                >
                                    <button
                                        type="button"
                                        title={t("sharing.open")}
                                        onClick={() => onOpen(share.threadId)}
                                        className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
                                    >
                                        <span
                                            className="min-w-0 truncate text-sm text-foreground"
                                            title={share.title}
                                        >
                                            {share.title}
                                        </span>
                                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                                            {[
                                                share.url ? null : t("sharing.linkOff"),
                                                share.people > 0
                                                    ? t("sharing.peopleCount", {
                                                          count: share.people
                                                      })
                                                    : null,
                                                t("history.shareUpdated", {
                                                    date: new Date(
                                                        share.sharedAt
                                                    ).toLocaleDateString(undefined, {
                                                        dateStyle: "medium"
                                                    })
                                                })
                                            ]
                                                .filter(Boolean)
                                                .join(" - ")}
                                        </span>
                                    </button>
                                    {share.url ? (
                                        <IconAction
                                            label={t("history.shareCopy")}
                                            onClick={() =>
                                                void copy(share.url ?? "").then((done) =>
                                                    done
                                                        ? toast.show({
                                                              title: t("history.shareCopied")
                                                          })
                                                        : null
                                                )
                                            }
                                        >
                                            <Link2 className="size-4" />
                                        </IconAction>
                                    ) : null}
                                    <IconAction
                                        label={t("sharing.stopAll")}
                                        onClick={() => setStopping(share)}
                                    >
                                        <Trash2 className="size-4" />
                                    </IconAction>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t("sharing.close")}
                    </Button>
                </DialogFooter>
                {stopping ? (
                    <ConfirmDeleteDialog
                        open
                        onOpenChange={(open) => (open ? undefined : setStopping(null))}
                        name={stopping.title}
                        requireTyping={false}
                        kind={t("sharing.kind")}
                        title={t("sharing.stopAllTitle")}
                        question={t("sharing.stopAllQuestion", { title: stopping.title })}
                        confirmLabel={t("sharing.stopAll")}
                        onConfirm={() => {
                            void stop(stopping);
                            setStopping(null);
                        }}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/** A saved link's limits as the Advanced section edits them. */
function advancedOf(link: PolarShareLink | null): LinkAdvancedValue {
    if (!link) return EMPTY_LINK_ADVANCED;
    return {
        password: "",
        expiresAt: linkExpiryDay(link.expiresAt),
        maxUses: link.maxViews === null ? "" : String(link.maxViews),
        allowedCidrs: link.allowedCidrs,
        allowedCountries: link.allowedCountries,
        allowedContinents: link.allowedContinents,
        ...linkGuardFields(link.guards)
    };
}
