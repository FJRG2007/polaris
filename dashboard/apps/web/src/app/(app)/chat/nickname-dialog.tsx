"use client";

/**
 * What you call the other person in a one-to-one conversation.
 *
 * Yours alone: nothing is announced, they are not told, and they go on being
 * called what they call themselves everywhere else. Which is why it is offered
 * from the row in the list as well as from the open conversation - it is a note
 * about a person, and the place somebody reaches for it is wherever their name
 * is written.
 *
 * Opened on what they are called now, so clearing the box is how the nickname
 * comes off.
 */

import { useEffect, useState } from "react";
import * as actions from "./actions";
import { runAction } from "@/lib/run-action";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from "@polaris/ui";

/** The longest a nickname may be, matching what the action will accept. A box
 *  that takes more than the server keeps is a save that silently truncates. */
const MAX_NICKNAME = 60;

export function NicknameDialog({
    open,
    onOpenChange,
    person,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Who it is about. Null closes the dialog rather than saving nothing. */
    person: { id: string; name: string } | null;
    onSaved: () => void;
}) {
    const [nickname, setNickname] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        if (open) {
            setNickname(person?.name ?? "");
            setError("");
        }
    }, [open, person?.name]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>What you call them</DialogTitle>
                </DialogHeader>
                <Input
                    value={nickname}
                    autoFocus
                    maxLength={MAX_NICKNAME}
                    aria-label="What you call them"
                    placeholder="Leave it empty to use their own name"
                    onChange={(event) => setNickname(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                    Only you see this. They are not told, and everybody else goes on seeing their
                    own name.
                </p>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={async () => {
                            if (!person) return;
                            const result = await runAction(
                                () => actions.setNicknameAction(person.id, nickname),
                                setError
                            );
                            // Left open on a refusal, with the reason under the
                            // box: a dialog that closes on a save that did not
                            // happen is a nickname somebody believes they set.
                            if (!result || result.error) return;
                            onOpenChange(false);
                            onSaved();
                        }}
                    >
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
