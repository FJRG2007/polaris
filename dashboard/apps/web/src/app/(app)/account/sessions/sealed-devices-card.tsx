"use client";

/**
 * The devices that read this account's encrypted chats (docs/chat-e2ee-mls.md,
 * "Device hygiene").
 *
 * Every browser or app that opened a sealed conversation holds keys to it, and
 * keeps receiving until it signs out or goes unused past the limit. This is
 * where somebody who got the "a new device can read your encrypted chats" alert,
 * or who lost a laptop, takes one off by hand.
 *
 * A device id is a random code the device made for itself, so the code, when it
 * was added and when it was last used are what a row can be recognised by. The
 * browser this page is open in is marked and offers no Remove: taking itself out
 * would only have it register again as a new device on the next chat.
 *
 * Removing does not end that browser's session. One still signed in joins again
 * as a new device the next time it opens a chat, which is why the confirmation
 * says to end its session in the list above as well.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Trash2 } from "lucide-react";
import { removeSealedDeviceAction } from "./actions";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { Badge, Button, Card, CardBody, cn, settingType } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export interface SealedDeviceRow {
    device: string;
    createdAt: string;
    lastSeenAt: string;
}

/** The short code a row is named by: the start of the id the device made. */
const shortCode = (device: string) => device.slice(0, 8);

export function SealedDevicesCard({ userId, devices }: { userId: string; devices: SealedDeviceRow[] }) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const [confirm, confirmElement] = useConfirm();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
    const [current, setCurrent] = useState<string | null>(null);

    // Read after paint, and only read: the module that knows the id is the chat
    // client's, which nothing on this page should load up front.
    useEffect(() => {
        let live = true;
        void import("@/lib/chat/e2ee/mls-browser")
            .then(({ existingBrowserDeviceId }) => {
                if (live) setCurrent(existingBrowserDeviceId(userId));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [userId]);

    async function remove(row: SealedDeviceRow) {
        const code = shortCode(row.device);
        const ok = await confirm({
            title: t("sessions.sealed.removeTitle"),
            description: t("sessions.sealed.removeDescription", { code }),
            confirmLabel: t("sessions.sealed.removeConfirm"),
            danger: true
        });
        if (!ok) return;
        setBusy(row.device);
        setError(null);
        // Gone from the list at once, back if the server refuses.
        setRemoved((before) => new Set(before).add(row.device));
        const result = await removeSealedDeviceAction(row.device).catch(() => ({ error: t("sessions.sealed.removeFailed") }));
        setBusy(null);
        if (result.error) {
            setRemoved((before) => {
                const next = new Set(before);
                next.delete(row.device);
                return next;
            });
            setError(result.error);
        } else router.refresh();
    }

    const shown = devices.filter((row) => !removed.has(row.device));

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("sessions.sealed.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("sessions.sealed.description")}</p>
                </div>

                {error ? (
                    <p role="alert" className={settingType.error}>
                        {error}
                    </p>
                ) : null}

                {shown.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">{t("sessions.sealed.empty")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {shown.map((row) => {
                            const code = shortCode(row.device);
                            const mine = row.device === current;
                            return (
                                <li
                                    key={row.device}
                                    className={cn("flex items-center gap-3 px-3 py-2 text-sm", busy === row.device && "opacity-60")}
                                >
                                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <p className="flex flex-wrap items-center gap-1.5">
                                            <span className="min-w-0 truncate font-mono text-xs" title={row.device}>
                                                {t("sessions.sealed.device", { code })}
                                            </span>
                                            {mine ? <Badge variant="primary">{t("sessions.sealed.thisBrowser")}</Badge> : null}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("sessions.sealed.added")} <RelativeTime iso={row.createdAt} />
                                            {" - "}
                                            {t("sessions.sealed.lastUsed")} <RelativeTime iso={row.lastSeenAt} />
                                        </p>
                                    </div>
                                    {mine ? null : (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            title={t("sessions.sealed.remove")}
                                            aria-label={t("sessions.sealed.removeNamed", { code })}
                                            disabled={busy !== null}
                                            onClick={() => void remove(row)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {confirmElement}
            </CardBody>
        </Card>
    );
}
