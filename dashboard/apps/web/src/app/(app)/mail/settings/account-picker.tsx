"use client";

/**
 * Which mailbox a settings screen is about.
 *
 * Every screen behind here is per mailbox, because the answers genuinely differ
 * per mailbox: a work signature is not a personal one, and the privacy somebody
 * wants on a newsletter account is not what they want on the one their bank
 * writes to. So rather than a global page with a mailbox dropdown buried in it,
 * the mailbox is picked at the top and the screen below is about that one.
 *
 * With a single mailbox this draws nothing at all. A picker with one option is a
 * control that exists to be ignored.
 */

import { cn } from "@polaris/ui";
import type { MailAccountView } from "@/lib/mailbox/accounts";

export function AccountPicker({
    accounts,
    value,
    onChange
}: {
    accounts: readonly MailAccountView[];
    value: string;
    onChange: (accountId: string) => void;
}) {
    if (accounts.length < 2) return null;
    return (
        <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Mailbox">
            {accounts.map((account) => (
                <button
                    key={account.id}
                    type="button"
                    role="tab"
                    aria-selected={account.id === value}
                    onClick={() => onChange(account.id)}
                    className={cn(
                        "rounded-md px-2.5 py-1 text-[13px]",
                        account.id === value
                            ? "bg-card font-medium text-foreground"
                            : "text-muted-foreground hover:bg-card hover:text-foreground"
                    )}
                >
                    {account.label || account.address}
                </button>
            ))}
        </div>
    );
}
