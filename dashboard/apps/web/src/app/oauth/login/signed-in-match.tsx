"use client";

/**
 * What the sign-in form says when the identifier being typed names an account
 * this browser (or app) is already signed in to: signing in again would only
 * open a second session of it, so the form offers the switch instead.
 *
 * Matched here, against the accounts the page was drawn with - the ones this
 * browser holds a session for. Nothing is asked of the server as the person
 * types, so the check cannot be used to learn whether an identifier exists.
 */

import { Button } from "@polaris/ui";
import { useEffect, useState } from "react";
import { leaveAccount } from "@/lib/account-switch";
import { AccountInitials } from "./account-chooser";
import { postLoginTarget } from "./post-login-target";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { signedInAccountFor, type PhoneCountry } from "@polaris/core";
import { switchAccountAction, type DeviceAccountView } from "@/app/device-account-actions";

/** One account signed in here, with what a typed identifier can name it by. */
export interface SignedInHere extends DeviceAccountView {
    readonly username: string | null;
    /** The account's verified phone number, when it has one. */
    readonly phone: string | null;
}

/** Long enough to skip the keystrokes in the middle of a word, short enough to
 *  read as immediate. Nothing leaves the page, so there is no cost to save. */
const MATCH_DELAY_MS = 150;

/** The account among `accounts` that `identifier` names, settled a moment
 *  after typing stops. Null when it names none of them. */
export function useSignedInMatch(
    identifier: string,
    accounts: readonly SignedInHere[],
    country: PhoneCountry | null
): SignedInHere | null {
    const [match, setMatch] = useState<SignedInHere | null>(null);
    useEffect(() => {
        if (accounts.length === 0 || !identifier.trim()) {
            setMatch(null);
            return;
        }
        const timer = setTimeout(
            () => setMatch(signedInAccountFor(identifier, accounts, country)),
            MATCH_DELAY_MS
        );
        return () => clearTimeout(timer);
    }, [identifier, accounts, country]);
    return match;
}

/**
 * The account the identifier names, and the one press that gets there: a
 * switch to it, or - when it is the account in use - back to where it was.
 */
export function SignedInNotice({ account, back }: { account: SignedInHere; back: string | null }) {
    const t = useTranslations("auth");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function go() {
        setBusy(true);
        setError(null);
        if (account.active) {
            window.location.assign(back ?? postLoginTarget());
            return;
        }
        const result = await switchAccountAction(account.id).catch(() => ({
            error: t("login.chooserError")
        }));
        if (result.error) {
            setError(result.error);
            setBusy(false);
            return;
        }
        await leaveAccount(back ?? postLoginTarget());
    }

    return (
        <div
            role="status"
            className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
            data-testid="signed-in-match"
        >
            <div className="flex min-w-0 items-center gap-3">
                <AccountInitials account={account} />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={account.name}>
                        {account.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={account.email}>
                        {account.email}
                    </span>
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                {account.active ? t("login.signedInHere.active") : t("login.signedInHere.other")}
            </p>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void go()}>
                {account.active ? t("login.signedInHere.back") : t("login.signedInHere.switch")}
            </Button>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
