"use client";

/**
 * What a session is tied to, beyond the cookie itself.
 *
 * A session cookie is a bearer token: it is the account, in whoever's hands it
 * lands. Everything else on this screen guards the moment of signing in - the
 * password, the second factor, the approval - and says nothing at all about the
 * hours afterwards, which is exactly the window a stolen cookie is worth
 * something in. This card is that window.
 *
 * Two settings, and the copy is honest about which one can be wrong. The client
 * binding cannot: a browser update changes a version and never a name, and the
 * one name a browser does rewrite about itself - the system, which any set of
 * developer tools will put a phone's on a laptop - is only acted on when the
 * address changed with it. The address binding can be wrong, and the note on
 * each choice says exactly when.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AddressPinScope } from "@polaris/core";
import { Feedback, type SettingLock } from "./setting-card";
import { updateSessionBindingAction } from "./actions";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { ADDRESS_PIN_SCOPES } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function SessionBindingCard({
    bindSessionsToClient,
    pinSessionsToAddress,
    lock
}: {
    bindSessionsToClient: boolean;
    pinSessionsToAddress: AddressPinScope;
    lock?: SettingLock;
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
    const [bindClient, setBindClient] = useState(bindSessionsToClient);
    const [scope, setScope] = useState<AddressPinScope>(pinSessionsToAddress);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);
    const locked = Boolean(lock);
    const changed = bindClient !== bindSessionsToClient || scope !== pinSessionsToAddress;

    async function save(): Promise<void> {
        setBusy(true);
        setResult(null);
        const answer = await updateSessionBindingAction({
            bindSessionsToClient: bindClient,
            pinSessionsToAddress: scope
        });
        setBusy(false);
        setResult(answer.error ? answer : { ok: t("feedback.saved") });
        if (!answer.error) router.refresh();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">{t("binding.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("binding.description")}</p>
                </div>

                {/* Both settings read the same way round - what it does on the left, the
                    control that changes it on the right - so the eye runs down one column
                    of prose and one column of controls instead of stepping around a
                    full-width dropdown between two rows that are not. */}
                <div className="flex flex-col gap-3">
                    <label className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                            <span className="block text-sm">{t("binding.client.label")}</span>
                            <span className="block text-xs text-muted-foreground">{t("binding.client.hint")}</span>
                        </span>
                        <Switch
                            checked={bindClient}
                            disabled={locked}
                            onChange={setBindClient}
                            aria-label={t("binding.client.label")}
                        />
                    </label>

                    <div className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                            <span className="block text-sm">{t("binding.address.label")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t(`binding.scopes.${scope}.note` as const)}
                            </span>
                        </span>
                        <Select
                            value={scope}
                            disabled={locked}
                            onValueChange={(value) => setScope(value as AddressPinScope)}
                            aria-label={t("binding.address.label")}
                            className="w-44 shrink-0"
                            options={ADDRESS_PIN_SCOPES.map((option) => ({
                                value: option,
                                label: t(`binding.scopes.${option}.label` as const)
                            }))}
                        />
                    </div>
                </div>

                {/* The footnote and Save share the last line rather than taking one each:
                    a button alone on a row leaves the width of the card empty beside it. */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("binding.perSession")}</p>
                    <div className="flex shrink-0 items-center gap-3">
                        <Feedback error={result?.error} ok={result?.ok} />
                        <Button onClick={() => void save()} disabled={locked || busy || !changed}>
                            {busy ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}
