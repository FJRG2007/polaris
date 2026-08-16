"use client";

/**
 * What the owner of a group decides about it.
 *
 * A group has no administrators - everybody in one is equal in it, which is what
 * makes it a group rather than a channel - so it has an owner instead: whoever
 * started it, until they hand it over. Two things are theirs and nobody else's:
 * whether the rest of the group may change how it looks, and who runs it next.
 *
 * Only shown to the owner. A screen that offers a switch the server will refuse
 * is worse than one that does not offer it, and the owner is the only person for
 * whom either of these is a question.
 */

import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import { listMembersAction, setGroupOptionsAction, transferGroupAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";

export function GroupSettingsDialog({
    channel,
    open,
    onOpenChange,
    onChanged
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const [members, setMembers] = useState<readonly ChatMemberView[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [handingTo, setHandingTo] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setHandingTo(null);
        setError("");
        void listMembersAction(channel.id).then((result) => setMembers(result.members ?? []));
    }, [open, channel.id]);

    const others = members.filter((member) => member.userId !== channel.ownerId);

    const setSwitch = async (next: boolean) => {
        setBusy(true);
        setError("");
        await runAction(() => setGroupOptionsAction(channel.id, next), setError);
        setBusy(false);
        onChanged();
    };

    const hand = async (userId: string) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => transferGroupAction(channel.id, userId), setError);
        setBusy(false);
        if (!result || result.error) return;
        setHandingTo(null);
        onChanged();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Group settings</DialogTitle>
                    <DialogDescription>
                        Yours, because you run this group. Everything else about it is everybody&apos;s.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                                Let anybody change the name and picture
                            </span>
                            <span className="text-xs text-muted-foreground">
                                Off, only you can. On, anybody in the group can.
                            </span>
                        </span>
                        <Switch
                            checked={channel.membersMayEdit}
                            disabled={busy}
                            onChange={(next: boolean) => void setSwitch(next)}
                            aria-label="Let anybody change the name and picture"
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Hand the group over</span>
                        <span className="text-xs text-muted-foreground">
                            They run it from then on. You stay in it.
                        </span>
                        {others.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                There is nobody else in this group yet.
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {others.map((member) => (
                                    <li
                                        key={member.userId}
                                        className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                                    >
                                        <Avatar
                                            size={24}
                                            person={{ id: member.userId, name: member.name }}
                                        />
                                        <span className="min-w-0 flex-1 truncate text-sm">
                                            {member.name}
                                        </span>
                                        {handingTo === member.userId ? (
                                            <>
                                                {/* Asked twice, because it cannot be
                                                    undone from this side: the person
                                                    it went to is the only one who can
                                                    hand it back. */}
                                                <Button
                                                    size="xs"
                                                    variant="danger"
                                                    disabled={busy}
                                                    onClick={() => void hand(member.userId)}
                                                >
                                                    Hand it over
                                                </Button>
                                                <Button
                                                    size="xs"
                                                    variant="ghost"
                                                    disabled={busy}
                                                    onClick={() => setHandingTo(null)}
                                                >
                                                    Cancel
                                                </Button>
                                            </>
                                        ) : (
                                            <Button
                                                size="xs"
                                                variant="secondary"
                                                disabled={busy}
                                                onClick={() => setHandingTo(member.userId)}
                                            >
                                                Make owner
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
