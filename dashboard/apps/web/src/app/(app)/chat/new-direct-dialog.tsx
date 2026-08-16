"use client";

/**
 * Starting a direct message.
 *
 * One person makes a two-way conversation and there is only ever one of those
 * with anybody - asking again reopens the one that exists, with its history,
 * rather than a second empty one. More than one makes a group, and asking twice
 * there does make two, because three people can genuinely want two different
 * conversations.
 *
 * Which of the two is a choice made at the top rather than inferred from how
 * many names end up in the box, because the two want opposite things from the
 * same screen. A direct message is one press: picking the person IS the
 * decision, and a confirm button after it asks somebody to agree with what they
 * just did. A group is not finished until the last person is in it, so that one
 * keeps its button.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { Loader2, MessageSquare, Users } from "lucide-react";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { openDirectAction, searchPeopleAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function NewDirectDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const { viewerId, refresh, may } = useChat();
    const [kind, setKind] = useState<"direct" | "group">("direct");
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const open_ = async (userIds: readonly string[]) => {
        if (userIds.length === 0) return;
        setBusy(true);
        setError("");
        const result = await runAction(() => openDirectAction({ userIds: [...userIds] }), setError);
        setBusy(false);
        if (result?.error || !result?.id) return;
        setPicked([]);
        onOpenChange(false);
        refresh();
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New message</DialogTitle>
                    <DialogDescription>
                        {may.groups
                            ? "One person, or several for a group."
                            : "Pick who to write to."}
                    </DialogDescription>
                </DialogHeader>

                {/* The choice only exists where a group can be started. An
                    account without that grant gets the screen it can use rather
                    than a tab that refuses. */}
                {may.groups && (
                    <div className="flex gap-1 rounded-md bg-muted p-0.5">
                        {(["direct", "group"] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={kind === option}
                                onClick={() => {
                                    setKind(option);
                                    setPicked([]);
                                    setError("");
                                }}
                                className={cn(
                                    "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
                                    kind === option
                                        ? "bg-card text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {option === "direct" ? (
                                    <MessageSquare className="size-3.5" />
                                ) : (
                                    <Users className="size-3.5" />
                                )}
                                {option === "direct" ? "Direct message" : "Group"}
                            </button>
                        ))}
                    </div>
                )}

                <PeoplePicker
                    search={searchPeopleAction}
                    picked={kind === "group" ? picked : []}
                    onChange={(next) => {
                        if (kind === "group") {
                            setPicked(next);
                            return;
                        }
                        // One press. Whoever was just chosen is the whole
                        // decision, so the conversation opens on the spot.
                        const person = next.at(-1);
                        if (person) void open_([person.id]);
                    }}
                    // Messaging yourself is not what anybody means by this, and
                    // the room it would open has nobody else in it.
                    exclude={[viewerId]}
                    label="Who to message"
                />

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {kind === "group" && (
                        <Button
                            size="sm"
                            disabled={busy || picked.length === 0}
                            onClick={() => void open_(picked.map((person) => person.id))}
                        >
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Start group
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
