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

import { cn, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MailAccountView } from "@/lib/mailbox/accounts";

/** Past this many accounts, tabs stop being readable at a glance. */
const MOST_TABS = 5;

export function AccountPicker({
    accounts,
    value,
    onChange
}: {
    accounts: readonly MailAccountView[];
    value: string;
    onChange: (accountId: string) => void;
}) {
    const t = useTranslations("mailSettings");
    if (accounts.length < 2) return null;
    if (accounts.length > MOST_TABS) {
        return (
            <Select
                className="mb-4 max-w-sm"
                aria-label={t("picker.label")}
                value={value}
                onValueChange={onChange}
                options={accounts.map((account) => ({
                    value: account.id,
                    label: account.label || account.address
                }))}
            />
        );
    }
    return (
        <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label={t("picker.label")}>
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
