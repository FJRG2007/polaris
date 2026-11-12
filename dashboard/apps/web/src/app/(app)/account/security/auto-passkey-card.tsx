"use client";

/**
 * Whether the sign-in screen and the vault's lock screen ask for a passkey the
 * moment they open, on a device that already holds one of this account's
 * passkeys (`lib/local-passkeys`).
 *
 * On by default: it saves a press and changes nothing about what signing in
 * takes - the passkey still asks for the face, finger or PIN that guards it. Off,
 * both screens wait for the button, as they did before this existed.
 */

import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { setAutoPasskeyAction } from "./actions";
import { Card, CardBody, Switch } from "@polaris/ui";
import { Feedback, type SettingLock } from "./setting-card";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function AutoPasskeyCard({ enabled, lock }: { enabled: boolean; lock?: SettingLock }) {
    const t = useTranslations("accountSecurity");
    const [on, setOn] = useState(enabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setOn(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => setAutoPasskeyAction(next), setError);
            if (!result || result.error) {
                setOn(!next);
                if (result?.error) setError(result.error);
            }
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("autoPasskey.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("autoPasskey.description")}</p>
                    </div>
                    <Switch
                        checked={on}
                        disabled={Boolean(lock) || pending}
                        onChange={toggle}
                        aria-label={t("autoPasskey.label")}
                    />
                </div>
                {lock ? <p className="text-xs text-muted-foreground">{lock.reason}</p> : null}
                <Feedback error={error} />
            </CardBody>
        </Card>
    );
}
