"use client";

/**
 * A signature, and where it sits on a reply.
 *
 * Save stays disabled until something actually differs from what was loaded, so
 * opening the screen and closing it writes nothing - and a value edited and put
 * back leaves it disabled too, because the mailbox is then exactly as it was.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { editAccountAction } from "@/app/(app)/mail/actions";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import * as core from "@polaris/core";
import { mailOptionLabel } from "@/app/(app)/mail/option-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Select, Switch, Textarea, useToast } from "@polaris/ui";

export function SignatureView({ accounts }: { accounts: MailAccountView[] }) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const tc = useTranslations("common");
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;

    const [signature, setSignature] = useState(account.signature);
    const [above, setAbove] = useState(account.signatureAboveQuote);
    const [auto, setAuto] = useState(account.signatureAuto);
    const [saving, startSaving] = useBusy();

    function pick(next: string): void {
        const chosen = accounts.find((one) => one.id === next);
        if (!chosen) return;
        setAccountId(next);
        setSignature(chosen.signature);
        setAbove(chosen.signatureAboveQuote);
        setAuto(chosen.signatureAuto);
    }

    const dirty =
        signature !== account.signature ||
        above !== account.signatureAboveQuote ||
        auto !== account.signatureAuto;

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={pick} />

            <div className="space-y-3">
                <label className="block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        {t("signature.signedFrom", { address: account.address })}
                    </span>
                    <Textarea
                        value={signature}
                        rows={6}
                        onChange={(event) => setSignature(event.target.value)}
                        placeholder={t("signature.placeholder")}
                    />
                </label>

                <label className="mb-3 block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        {t("signature.when")}
                    </span>
                    <Select
                        value={auto}
                        onValueChange={setAuto}
                        aria-label={t("signature.whenLabel")}
                        className="w-64"
                        options={core.mailSignatureAuto.options.map((one) => ({
                            value: one,
                            label: one in core.MAIL_SIGNATURE_AUTO_LABELS ? mailOptionLabel(tm, "signatureAuto", one) : one
                        }))}
                    />
                    <span className="mt-1 block text-[12px] text-foreground-subtle">
                        {t("signature.whenHint")}
                    </span>
                </label>

                <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Switch
                        checked={above}
                        onChange={setAbove}
                        aria-label={t("signature.aboveLabel")}
                    />
                    {t("signature.above")}
                </label>
                <p className="text-[12px] text-foreground-subtle">
                    {t("signature.aboveHint")}
                </p>

                <Button
                    disabled={!dirty || saving}
                    onClick={() =>
                        startSaving(async () => {
                            const answer = await editAccountAction(account.id, {
                                displayName: account.displayName,
                                label: account.label,
                                color: account.color,
                                notify: account.notify,
                                pollSeconds: account.pollSeconds,
                                unified: account.unified,
                                appendToSent: account.appendToSent,
                                signature,
                                signatureAboveQuote: above,
                                signatureAuto: auto
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: t("signature.saved") });
                            router.refresh();
                        })
                    }
                >
                    {tc("actions.save")}
                </Button>
            </div>
        </div>
    );
}
