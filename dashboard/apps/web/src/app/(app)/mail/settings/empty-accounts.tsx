/**
 * What every settings screen shows before there is a mailbox to configure.
 *
 * A screen that says "no mailboxes" and offers no way to add one has told
 * somebody they are stuck, so this is a link rather than a sentence.
 */

import Link from "next/link";
import { getTranslations } from "@/lib/i18n/request";

/** The settings screens that wait for a mailbox, each named in its own sentence. */
export type PerMailboxSetting = "archive" | "away" | "identities" | "junk" | "privacy" | "rules" | "signature";

export async function NoMailboxes({ what }: { what: PerMailboxSetting }) {
    const t = await getTranslations("mailSettings");
    return (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-[13px] font-medium">{t("noMailboxes.title")}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
                {t.rich("noMailboxes.body", {
                    what,
                    link: (chunks) => (
                        <Link key="link" href="/mail/settings/accounts" className="underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </div>
    );
}
