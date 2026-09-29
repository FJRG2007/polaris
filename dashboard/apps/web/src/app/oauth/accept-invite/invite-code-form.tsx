"use client";

/**
 * The way in for an invite that travelled as a code rather than a link. The code
 * is checked before anything else is asked for, so somebody who mistyped it
 * finds out immediately instead of after filling in a whole profile.
 */

import { useState, type FormEvent } from "react";
import { formatInviteCode, INVITE_CODE_LENGTH, normalizeInviteCode } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { AcceptInviteForm } from "./accept-invite-form";
import { lookupInviteCodeAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function InviteCodeForm() {
    const t = useTranslations("auth");
    const [code, setCode] = useState("");
    const [invite, setInvite] = useState<{ email: string; needsPassword: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const normalized = normalizeInviteCode(code);

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await lookupInviteCodeAction(normalized);
        setPending(false);
        if (result.error || !result.invite) {
            setError(result.error ?? t("invite.codeNoMatch"));
            return;
        }
        setInvite(result.invite);
    }

    if (invite) {
        return <AcceptInviteForm code={normalized} email={invite.email} needsPassword={invite.needsPassword} />;
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("invite.codeTitle")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        <Input
                            autoComplete="off"
                            autoFocus
                            spellCheck={false}
                            // i18n-ignore - the shape of a code, not words
                            placeholder="ABCD-EFGH-JKMN"
                            aria-label={t("invite.codeLabel")}
                            className="text-center font-mono tracking-widest"
                            value={formatInviteCode(code)}
                            onChange={(event) => setCode(normalizeInviteCode(event.target.value))}
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || normalized.length !== INVITE_CODE_LENGTH}>
                            {pending ? t("invite.checking") : t("invite.continue")}
                        </Button>
                    </form>
                    <a href="/oauth/login" className="mt-4 block text-center text-sm text-primary hover:underline">
                        {t("invite.goToSignIn")}
                    </a>
                </CardBody>
            </Card>
        </main>
    );
}
