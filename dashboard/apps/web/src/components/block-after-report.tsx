"use client";

/**
 * "Do you also want to block them?", asked at the one moment somebody actually
 * wants to be asked.
 *
 * Reporting and blocking are different acts and are deliberately separate
 * everywhere else: reporting asks somebody else to decide, and blocking is this
 * reader deciding for themselves, straight away. But they are the same *moment* -
 * whoever has just reported an account almost always wants to stop hearing from
 * it, and making them close the dialog and hunt for a second menu is how the
 * second half does not happen.
 *
 * So it is offered once, after the report has gone, as a single press. One
 * component because both dialogs - the one about a message and the one about an
 * account - reach the same moment, and two copies would drift.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { Loader2, ShieldBan, ShieldCheck } from "lucide-react";
import { blockPersonAction } from "@/app/(app)/account/privacy/actions";

export function BlockAfterReport({
    person
}: {
    /** Who to offer to block. Null where the account is not known - a message
     *  whose author has since left - and then nothing is drawn rather than a
     *  button that cannot work. */
    person: { id: string; name: string } | null;
}) {
    const [blocked, setBlocked] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!person) return null;

    async function block(): Promise<void> {
        if (!person) return;
        setBusy(true);
        setError(null);
        const result = await runAction(() => blockPersonAction({ userId: person.id }), setError);
        setBusy(false);
        if (!result || result.error) return;
        setBlocked(true);
    }

    return (
        <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                    <span className="block text-sm">
                        {blocked ? `${person.name} is blocked` : `Block ${person.name}?`}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                        {blocked
                            ? "They cannot message or call you, and you will not see what they say."
                            : "Separate from the report, and it works straight away. Nobody is told."}
                    </span>
                </span>
                {blocked ? (
                    <ShieldCheck className="size-4 shrink-0 text-success" />
                ) : (
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void block()}>
                        {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            <ShieldBan className="size-3.5" />
                        )}
                        Block
                    </Button>
                )}
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
