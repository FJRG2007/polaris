"use client";

/**
 * The owner's arrangement of their badges: order (drag the handle, or arrow
 * keys on it), hide, who sees each one, and its details.
 *
 * Every change is shown at once and saved in the background; a save that fails
 * puts the list back as it was and says so.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useEffect, useRef, useState } from "react";
import { BadgeIcon } from "@/components/badges/badge-icon";
import { AudienceDialog } from "../privacy/audience-dialog";
import { Eye, EyeOff, GripVertical, Info } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BadgeDetail, badgeName } from "@/components/badges/badges-dialog";
import type { BadgeArrangement, BadgeView } from "@/lib/badges/badge-service";
import { loadMyBadgesAction, saveBadgeArrangementAction, type MyBadges } from "./actions";
import {
    Button,
    Card,
    cn,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Select,
    Skeleton,
    useListOrder,
    moved,
    useToast
} from "@polaris/ui";

/** The Select value for "follow the account's badges setting". */
const FOLLOW = "follow";
const cacheKey = (userId: string) => `polaris.badges.mine:${userId}`;

interface Row {
    badge: BadgeView;
    hidden: boolean;
    audience: core.PrivacyAudience | null;
    listId: string | null;
    people: string[];
}

function rowsOf(data: MyBadges): Row[] {
    const byKey = new Map((data.arrangement ?? []).map((row) => [row.badge, row]));
    return data.shown.map((badge) => {
        const pref = byKey.get(badge.key);
        return {
            badge,
            hidden: pref?.hidden ?? false,
            audience: pref?.audience ?? null,
            listId: pref?.listId ?? null,
            people: pref?.people ?? []
        };
    });
}

/** What is saved for a list of rows: the same shape the server validates. */
function arrangementOf(rows: readonly Row[]): BadgeArrangement[] {
    return rows.map((row) => ({
        badge: row.badge.key,
        hidden: row.hidden,
        audience: row.audience,
        listId: row.listId,
        people: row.people
    }));
}

function readCache(userId: string): MyBadges | null {
    try {
        const raw = sessionStorage.getItem(cacheKey(userId));
        return raw ? (JSON.parse(raw) as MyBadges) : null;
    } catch {
        return null;
    }
}

function writeCache(userId: string, data: MyBadges): void {
    try {
        sessionStorage.setItem(cacheKey(userId), JSON.stringify(data));
    } catch {
        // A browser that keeps nothing still shows the screen; it only loads again.
    }
}

export function BadgesSettings({ userId }: { userId: string }) {
    const t = useTranslations("badges");
    const tp = useTranslations("accountPrivacy");
    const toast = useToast();
    const [data, setData] = useState<MyBadges | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const [failed, setFailed] = useState(false);
    const [named, setNamed] = useState<{ id: string; name: string }[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [details, setDetails] = useState<BadgeView | null>(null);
    // The last list the server accepted, which a failed save goes back to.
    const saved = useRef<Row[]>([]);
    const latest = useRef(0);
    const queue = useRef<Promise<void>>(Promise.resolve());

    useEffect(() => {
        const cached = readCache(userId);
        const take = (next: MyBadges) => {
            setData(next);
            setRows(rowsOf(next));
            saved.current = rowsOf(next);
            setNamed(next.people);
        };
        if (cached) take(cached);
        loadMyBadgesAction()
            .then((next) => {
                writeCache(userId, next);
                take(next);
            })
            .catch(() => setFailed(true));
    }, [userId]);

    const commit = (next: Row[]) => {
        if (JSON.stringify(arrangementOf(next)) === JSON.stringify(arrangementOf(rows))) return;
        const turn = ++latest.current;
        setRows(next);
        queue.current = queue.current.then(() =>
            saveBadgeArrangementAction(arrangementOf(next))
                .then((answer) => {
                    if (answer.error) throw new Error(answer.error);
                    saved.current = next;
                    if (data) writeCache(userId, { ...data, arrangement: arrangementOf(next) });
                })
                .catch(() => {
                    if (turn !== latest.current) return;
                    setRows(saved.current);
                    toast.show({ title: t("settings.failed") });
                })
        );
    };

    const update = (key: string, change: Partial<Row>) =>
        commit(rows.map((row) => (row.badge.key === key ? { ...row, ...change } : row)));

    const order = useListOrder(
        rows.length,
        (from, to) => commit(moved(rows, from, to)),
        rows.map((row) => row.badge.key)
    );

    const editingRow = rows.find((row) => row.badge.key === editing) ?? null;

    return (
        <>
            <Card>
                {data === null && !failed && (
                    <ul className="flex flex-col divide-y divide-border">
                        {[0, 1, 2].map((index) => (
                            <li key={index} className="flex items-center gap-3 p-3">
                                <Skeleton className="size-9 rounded-full" />
                                <Skeleton className="h-4 w-40" />
                            </li>
                        ))}
                    </ul>
                )}
                {failed && data === null && <EmptyState title={t("settings.failed")} />}
                {data !== null && rows.length === 0 && <EmptyState title={t("settings.empty")} />}
                {rows.length > 0 && (
                    <ul className="flex flex-col divide-y divide-border" {...order.listProps}>
                        {rows.map((row, index) => {
                            const name = badgeName(t, row.badge);
                            return (
                                <li
                                    key={row.badge.key}
                                    className={cn(
                                        "relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 p-3",
                                        order.dragging === index && "opacity-40",
                                        row.hidden && "text-muted-foreground"
                                    )}
                                    {...order.rowProps(index)}
                                >
                                    {order.dragging !== null && order.dropAt === index && (
                                        <span
                                            aria-hidden="true"
                                            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-primary"
                                        />
                                    )}
                                    <button
                                        type="button"
                                        aria-label={t("settings.move", { name })}
                                        title={t("settings.move", { name })}
                                        className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                                        {...order.handleProps(index, rows.length)}
                                    >
                                        <GripVertical className="size-3.5" />
                                    </button>
                                    <BadgeIcon
                                        icon={row.badge.icon}
                                        kind={row.badge.kind}
                                        level={row.badge.level}
                                        locked={row.hidden}
                                        className="size-9 shrink-0"
                                    />
                                    <span
                                        className="min-w-0 flex-1 truncate text-[0.8125rem]"
                                        title={name}
                                    >
                                        {name}
                                    </span>
                                    <Select
                                        className="h-8 w-full shrink-0 text-xs sm:w-52"
                                        aria-label={t("settings.audience", { name })}
                                        value={row.audience ?? FOLLOW}
                                        disabled={row.hidden}
                                        options={[
                                            { value: FOLLOW, label: t("settings.followAccount") },
                                            ...core.PRIVACY_AUDIENCES.map((audience) => ({
                                                value: audience,
                                                label: tp(`audiences.${audience}` as const)
                                            }))
                                        ]}
                                        onValueChange={(value) => {
                                            const audience =
                                                value === FOLLOW
                                                    ? null
                                                    : (value as core.PrivacyAudience);
                                            update(row.badge.key, { audience });
                                            if (audience && core.audienceNeedsList(audience))
                                                setEditing(row.badge.key);
                                        }}
                                    />
                                    {row.audience &&
                                        core.audienceNeedsList(row.audience) &&
                                        !row.hidden && (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() => setEditing(row.badge.key)}
                                            >
                                                {t("settings.people")}
                                            </Button>
                                        )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t(
                                            row.hidden ? "settings.show" : "settings.hide",
                                            { name }
                                        )}
                                        title={t(row.hidden ? "settings.show" : "settings.hide", {
                                            name
                                        })}
                                        aria-pressed={row.hidden}
                                        onClick={() =>
                                            update(row.badge.key, { hidden: !row.hidden })
                                        }
                                    >
                                        {row.hidden ? (
                                            <EyeOff className="size-4" />
                                        ) : (
                                            <Eye className="size-4" />
                                        )}
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("settings.details", { name })}
                                        title={t("settings.details", { name })}
                                        onClick={() => setDetails(row.badge)}
                                    >
                                        <Info className="size-4" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>
            <p className="text-xs text-muted-foreground">
                {t.rich("settings.privacyLink", {
                    link: (chunks) => (
                        <Link href="/account/privacy" className="underline underline-offset-2">
                            {chunks}
                        </Link>
                    )
                })}
            </p>

            {editingRow && data && (
                <AudienceDialog
                    field="badges"
                    rule={{
                        audience: editingRow.audience ?? "everyone",
                        listId: editingRow.listId,
                        people: editingRow.people
                    }}
                    lists={data.lists}
                    named={named}
                    onNamed={(person) =>
                        setNamed((current) =>
                            current.some((entry) => entry.id === person.id)
                                ? current
                                : [...current, person]
                        )
                    }
                    onChange={(rule) =>
                        update(editingRow.badge.key, {
                            audience: rule.audience,
                            listId: rule.listId,
                            people: [...rule.people]
                        })
                    }
                    onClose={() => setEditing(null)}
                />
            )}

            {details && (
                <Dialog open onOpenChange={(open) => !open && setDetails(null)}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>{badgeName(t, details)}</DialogTitle>
                        </DialogHeader>
                        <BadgeDetail
                            badge={details}
                            hidden={
                                rows.find((row) => row.badge.key === details.key)?.hidden ?? false
                            }
                        />
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}
