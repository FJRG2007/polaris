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
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { stopSharingAction } from "../sharing-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { FolderOpen, Share2, Trash2, Users } from "lucide-react";
import type { DriveShareRole, SharedItem } from "@/lib/drive-sharing";

const ROLE_LABELS: Record<DriveShareRole | "custom", string> = {
    viewer: "Can view",
    editor: "Can edit",
    custom: "Custom access"
};

export function SharedItemsView({ withMe, byMe }: { withMe: SharedItem[]; byMe: SharedItem[] }) {
    const [given, setGiven] = useState(byMe);
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    async function stop(item: SharedItem) {
        const who = item.recipient?.name ?? "them";
        const ok = await confirm({
            title: `Stop sharing ${item.name}?`,
            description: `${who} will no longer be able to open it.`,
            confirmLabel: "Stop sharing",
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
                <h2 className="text-sm font-medium">Shared with me</h2>
                {withMe.length === 0 ? (
                    <Empty
                        icon={<Share2 className="size-4" />}
                        line="Nothing yet. When somebody shares a file or folder with you, it appears here."
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {withMe.map((item) => (
                            <ItemRow key={item.id} item={item} person={item.owner} label="From" />
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Shared by me</h2>
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
                                label="With"
                                action={
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={busy === item.id}
                                        title="Stop sharing"
                                        aria-label={`Stop sharing ${item.name}`}
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
                    <Badge>{ROLE_LABELS[item.role]}</Badge>
                    {item.expiresAt && (
                        <Badge variant="warning">Until {format.date(item.expiresAt)}</Badge>
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
