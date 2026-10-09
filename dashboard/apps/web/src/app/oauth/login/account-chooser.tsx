"use client";

/**
 * The accounts this browser is still signed in to, offered on the sign-in page
 * when none of them is active - after signing one out, or after leaving a second
 * sign-in half done. Google's chooser: one press continues as that account, and
 * the form below is for any other.
 *
 * Initials rather than the photo: a picture is served to a signed-in reader, and
 * on this page nobody is.
 */

import { useState } from "react";
import { leaveAccount } from "@/lib/account-switch";
import { postLoginTarget } from "./post-login-target";
import { initials, initialsInk, tintFor } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { switchAccountAction, type DeviceAccountView } from "@/app/device-account-actions";

export function AccountChooser({ accounts }: { accounts: DeviceAccountView[] }) {
    const t = useTranslations("auth");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function choose(account: DeviceAccountView) {
        setBusy(account.id);
        setError(null);
        const result = await switchAccountAction(account.id).catch(() => ({ error: t("login.chooserError") }));
        if (result.error) {
            setError(result.error);
            setBusy(null);
            return;
        }
        await leaveAccount(postLoginTarget());
    }

    return (
        <section className="mb-4 flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">{t("login.chooserTitle")}</h2>
            <ul className="flex flex-col gap-1">
                {accounts.map((account) => {
                    const tint = tintFor(account.userId);
                    return (
                        <li key={account.id}>
                            <button
                                type="button"
                                disabled={busy !== null}
                                onClick={() => void choose(account)}
                                aria-label={t("login.chooserContinue", { name: account.name })}
                                className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
                            >
                                <span
                                    aria-hidden
                                    className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
                                    style={{ backgroundColor: tint, color: initialsInk(tint) }}
                                >
                                    {initials(account.name)}
                                </span>
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm font-medium" title={account.name}>
                                        {account.name}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground" title={account.email}>
                                        {account.email}
                                    </span>
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <p className="text-center text-xs text-muted-foreground">{t("login.chooserOr")}</p>
        </section>
    );
}
