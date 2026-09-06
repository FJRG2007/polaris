/**
 * What every settings screen shows before there is a mailbox to configure.
 *
 * A screen that says "no mailboxes" and offers no way to add one has told
 * somebody they are stuck, so this is a link rather than a sentence.
 */

import Link from "next/link";

export function NoMailboxes({ what }: { what: string }) {
    return (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-[13px] font-medium">No mailboxes yet</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
                {what} is set per mailbox.{" "}
                <Link href="/mail/settings/accounts" className="underline">
                    Connect one
                </Link>{" "}
                and this screen fills in.
            </p>
        </div>
    );
}
