"use client";

/**
 * The other addresses a mailbox may send from.
 *
 * Nothing here claims to have checked that the mail server will accept one. Only
 * the server can say that, and it says it by refusing the message - so the
 * screen says as much rather than showing a tick it has not earned.
 */

import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailIdentityView } from "@/lib/mailbox/labels";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Input, Switch, Textarea, cn, useToast } from "@polaris/ui";
import { deleteIdentityAction, saveIdentityAction } from "@/app/(app)/mail/actions";
import { addressState } from "@/app/(app)/mail/address-state";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function IdentitiesView({
    accounts,
    identities
}: {
    accounts: MailAccountView[];
    identities: Record<string, MailIdentityView[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const mine = identities[account.id] ?? [];
    const [adding, setAdding] = useState(false);

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h2 className="text-[13px] font-medium">
                        {t("identities.title", { address: account.address })}
                    </h2>
                    <p className="text-[12px] text-muted-foreground">{t("identities.hint")}</p>
                </div>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("identities.add")}
                </Button>
            </div>

            {mine.length === 0 && !adding ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    {t("identities.empty", { address: account.address })}
                </p>
            ) : null}

            <ul className="space-y-2">
                {mine.map((identity) => (
                    <li
                        key={identity.id}
                        className="rounded-md border border-border bg-card px-3 py-2"
                    >
                        <div className="flex items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <p
                                    className="truncate text-[13px] font-medium"
                                    title={identity.address}
                                >
                                    {identity.address}
                                </p>
                                <p className="truncate text-[12px] text-muted-foreground">
                                    {identity.displayName || t("identities.noName")}
                                    {identity.isDefault ? t("identities.default") : ""}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("identities.remove", { address: identity.address })}
                                title={t("identities.remove", { address: identity.address })}
                                onClick={() =>
                                    void (async () => {
                                        const answer = await deleteIdentityAction(
                                            account.id,
                                            identity.id
                                        );
                                        const said = refusalOf(answer);
                                        if (said) {
                                            toast.show({ title: said });
                                            return;
                                        }
                                        router.refresh();
                                    })()
                                }
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>

            {adding ? (
                <IdentityForm
                    accountId={account.id}
                    // Every address this mailbox can already send as, its own
                    // included: adding the mailbox's own address as a send-as is
                    // the same duplicate, and it is the one somebody types first.
                    taken={[account.address, ...mine.map((identity) => identity.address)]}
                    onDone={() => {
                        setAdding(false);
                        router.refresh();
                    }}
                    onCancel={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

function IdentityForm({
    accountId,
    taken,
    onDone,
    onCancel
}: {
    accountId: string;
    /** The addresses this mailbox already sends as. The server refuses a repeat
     *  in the same words - see `saveIdentity` - and this says so while it is
     *  being typed rather than after Add it. */
    taken: readonly string[];
    onDone: () => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tc = useTranslations("common");
    const [address, setAddress] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [replyTo, setReplyTo] = useState("");
    const [signature, setSignature] = useState("");
    const [isDefault, setIsDefault] = useState(false);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useBusy();

    // Read as it is typed, against the list this screen is already showing.
    const state = addressState(address, taken);
    const wrong =
        state === "invalid"
            ? t("identities.invalid")
            : state === "taken"
              ? t("identities.taken")
              : "";

    return (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("identities.address")} <span aria-hidden>*</span>
                </span>
                <Input
                    value={address}
                    autoFocus
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    aria-invalid={wrong ? true : undefined}
                    aria-describedby="identity-address"
                    onChange={(event) => setAddress(event.target.value)}
                />
                <span
                    id="identity-address"
                    className={cn(
                        "mt-1 block text-[12px]",
                        wrong ? "text-danger" : "text-foreground-subtle"
                    )}
                >
                    {wrong || t("identities.addressHint")}
                </span>
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("identities.name")}
                </span>
                <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                />
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("identities.replyTo")}
                </span>
                <Input value={replyTo} onChange={(event) => setReplyTo(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("identities.signature")}
                </span>
                <Textarea
                    rows={3}
                    value={signature}
                    onChange={(event) => setSignature(event.target.value)}
                />
            </label>
            <label className="flex items-center gap-2 text-[13px]">
                <Switch
                    checked={isDefault}
                    onChange={setIsDefault}
                    aria-label={t("identities.defaultLabel")}
                />
                {t("identities.defaultToggle")}
            </label>

            {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

            <div className="flex gap-2">
                <Button
                    disabled={saving || state !== "ok"}
                    onClick={() =>
                        startSaving(async () => {
                            setProblem("");
                            const answer = await saveIdentityAction(accountId, null, {
                                address,
                                displayName,
                                replyTo,
                                signature,
                                isDefault
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                setProblem(said);
                                return;
                            }
                            toast.show({ title: t("identities.added", { address }) });
                            onDone();
                        })
                    }
                >
                    {t("identities.addIt")}
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                    {tc("actions.cancel")}
                </Button>
            </div>
        </div>
    );
}
