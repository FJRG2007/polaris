"use client";

/**
 * How much of each mailbox Polaris keeps the words of.
 *
 * It belongs on this screen rather than under Mail because it is not a
 * preference anybody reading their mail has: it is disk. A synced message is an
 * envelope and costs a few hundred bytes; the message itself is the newsletter,
 * the quoted thread, the signature image referenced twice - and holding every
 * one of them for every mailbox is how a server fills up without anybody having
 * done anything.
 *
 * Zero is offered deliberately. A deployment whose mail server is on the same
 * LAN answers in a millisecond, so there is nothing for a held copy to save; one
 * short of disk would rather spend the second.
 */

import { runAction } from "@/lib/run-action";
import { MAIL_BODY_KEEP_MAX } from "@polaris/core";
import { useEffect, useState, useTransition } from "react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { mailBodyHeldAction, saveMailBodyKeepAction } from "./actions";

/** What the card says about the count while it is still being read, and when it
 *  could not be. Neither is an error worth the form's own error line: the
 *  setting above is editable and savable whether or not this number arrives. */
function heldLine(held: number | null, failed: boolean): string {
    if (failed) return "How much is held could not be read just now.";
    if (held === null) return "Counting what is held right now.";
    if (held === 0) return "No message is being held whole right now.";
    return `${held.toLocaleString()} ${held === 1 ? "message is" : "messages are"} being held whole right now.`;
}

export function MailBodyForm({ kept }: { kept: number }) {
    const [value, setValue] = useState(String(kept));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();
    // Read here rather than handed down by the page: counting held bodies is a
    // scan of the whole message table, and awaited on the server it stood
    // between somebody and this screen. The card is up immediately and the
    // number follows.
    const [held, setHeld] = useState<number | null>(null);
    const [countFailed, setCountFailed] = useState(false);

    useEffect(() => {
        void runAction(() => mailBodyHeldAction(), () => setCountFailed(true)).then((result) => {
            if (result) setHeld(result.held);
        });
    }, []);

    const parsed = Number.parseInt(value, 10);
    const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAIL_BODY_KEEP_MAX;
    // Dirty means it differs from what is stored, not that somebody typed in it.
    const dirty = valid && parsed !== kept;

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await saveMailBodyKeepAction(parsed);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Holding mail to read</h2>
                    <p className="max-w-xl text-sm text-muted-foreground">
                        Recent messages are brought down whole as they arrive, so opening one is
                        instant rather than a round trip to the mail server. Older messages keep
                        their headline here and are fetched when somebody opens them.
                    </p>
                </div>

                <label className="flex max-w-[12rem] flex-col gap-1 text-sm">
                    <span className="font-medium">
                        Messages held per mailbox <span aria-hidden="true">*</span>
                    </span>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAIL_BODY_KEEP_MAX}
                        value={value}
                        aria-label="Messages per mailbox kept whole"
                        aria-invalid={value.trim() !== "" && !valid}
                        onChange={(event) => setValue(event.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">
                        {parsed === 0 && valid
                            ? "Zero fetches every message the moment it is opened."
                            : "The newest of each mailbox. The rest are let go on the next sync."}
                    </span>
                </label>

                <p className="text-sm text-muted-foreground">{heldLine(held, countFailed)}</p>

                {error && <p className="text-sm text-danger">{error}</p>}
                {saved && !dirty && <p className="text-sm text-muted-foreground">Saved.</p>}

                <Button
                    className="self-start"
                    size="sm"
                    disabled={!dirty || pending}
                    onClick={save}
                >
                    Save
                </Button>
            </CardBody>
        </Card>
    );
}
