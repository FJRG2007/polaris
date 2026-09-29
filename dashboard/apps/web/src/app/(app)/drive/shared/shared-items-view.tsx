"use client";

/**
 * The two lists on the Shared screen.
 *
 * A row is a thing, not a rule: what it is called, whose it is, what you may do
 * with it, and a way in. The rule behind it (which verbs, on which path, for
 * which principal) belongs on the access rules screen and would only get in the
 * way here - somebody looking at this list is deciding whether to open something
 * or take it back, not auditing a policy.
 */

import Link from "next/link";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { stopSharingAction } from "../sharing-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { FolderOpen, Share2, Trash2, Users } from "lucide-react";
import type { DriveShareRole, SharedItem } from "@/lib/drive-sharing";

const ROLE_LABELS = {
    viewer: "roles.viewer",
    editor: "roles.editor",
    custom: "roles.custom"
} as const satisfies Record<DriveShareRole | "custom", NamespaceKey<"drive">>;

export function SharedItemsView({ withMe, byMe }: { withMe: SharedItem[]; byMe: SharedItem[] }) {
    const t = useTranslations("drive");
    const [given, setGiven] = useState(byMe);
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    async function stop(item: SharedItem) {
        const who = item.recipient?.name ?? null;
        const ok = await confirm({
            title: t("sharedItems.stopTitle", { name: item.name }),
            description: who ? t("sharedItems.stopBody", { name: who }) : t("sharedItems.stopBodyThem"),
            confirmLabel: t("sharedItems.stopSharing"),
            danger: true
        });
        if (!ok) return;
        setBusy(item.id);
        const result = await stopSharingAction(item.connectionId, item.id);
        if (!result.error) setGiven((rows) => rows.filter((row) => row.id !== item.id));
        setBusy(null);
    }

    return (
        <div className="flex flex-col gap-6">
            {confirmDialog}
            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{t("sharedItems.sharedWithMe")}</h2>
                {withMe.length === 0 ? (
                    <Empty
                        icon={<Share2 className="size-4" />}
                        line="Nothing yet. When somebody shares a file or folder with you, it appears here."
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {withMe.map((item) => (
                            <ItemRow key={item.id} item={item} person={item.owner} label={t("sharedItems.from")} />
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{t("sharedItems.sharedByMe")}</h2>
                {given.length === 0 ? (
                    <Empty
                        icon={<Share2 className="size-4" />}
                        line="Nothing yet. Right-click a file or folder in your Drive and choose Share with people."
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {given.map((item) => (
                            <ItemRow
                                key={item.id}
                                item={item}
                                person={item.recipient ?? item.owner}
                                label={t("sharedItems.with")}
                                action={
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={busy === item.id}
                                        title={t("sharedItems.stopSharing")}
                                        aria-label={t("sharedItems.stopNamed", { name: item.name })}
                                        onClick={() => void stop(item)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                }
                            />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function ItemRow({
    item,
    person,
    label,
    action
}: {
    item: SharedItem;
    person: { type: "user" | "group"; id: string; name: string };
    /** Whether the face beside it is who it came from or who it went to. */
    label: string;
    action?: React.ReactNode;
}) {
    const t = useTranslations("drive");
    const format = useDisplayFormat();
    const href = `/drive/open?c=${encodeURIComponent(item.connectionId)}&p=${encodeURIComponent(item.path)}`;

    return (
        <li>
            <Card>
                <CardBody className="flex items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <FolderOpen className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <Link
                            href={href}
                            className="block truncate text-sm font-medium hover:underline"
                        >
                            {item.name}
                        </Link>
                        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                            <span>{label}</span>
                            {person.type === "group" ? (
                                <Users className="size-3 shrink-0" />
                            ) : (
                                <Avatar person={{ id: person.id, name: person.name }} size={16} />
                            )}
                            <span className="truncate" title={person.name}>
                                {person.name}
                            </span>
                            <span aria-hidden>-</span>
                            <span>{format.date(item.sharedAt)}</span>
                        </p>
                        {item.note && (
                            <p className="truncate text-xs text-muted-foreground" title={item.note}>
                                {item.note}
                            </p>
                        )}
                    </div>
                    <Badge>{t(ROLE_LABELS[item.role])}</Badge>
                    {item.expiresAt && (
                        <Badge variant="warning">{t("sharedItems.until", { date: format.date(item.expiresAt) })}</Badge>
                    )}
                    {action}
                </CardBody>
            </Card>
        </li>
    );
}

function Empty({ icon, line }: { icon: React.ReactNode; line: string }) {
    return (
        <Card>
            <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
                {icon}
                {line}
            </CardBody>
        </Card>
    );
}
