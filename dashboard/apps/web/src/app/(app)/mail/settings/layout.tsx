/**
 * The settings behind Mail.
 *
 * Its own sub-rail rather than entries in the app rail, for the same reason the
 * app rail is the mailboxes: a rail that mixed "Inbox" with "Filters" would put
 * a place you go twenty times a day next to one you go to twice a year.
 */

import Link from "next/link";
import { SettingsNav } from "./settings-nav";

export const dynamic = "force-dynamic";

export default function MailSettingsLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6">
            <div className="mb-4 flex items-baseline gap-3">
                <h1 className="text-[17px] font-semibold tracking-tight">Mail settings</h1>
                <Link href="/mail" className="text-[12px] text-muted-foreground hover:text-foreground">
                    Back to the inbox
                </Link>
            </div>
            <SettingsNav />
            <div className="mt-4">{children}</div>
        </div>
    );
}
