"use client";

/**
 * The field a join code is typed into. What it leads to is the meeting's own
 * link, which then asks for a name, a sign-in or a password as the link does.
 */

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { joinWithCodeAction } from "./actions";
import { PublicShell } from "@/components/public-shell";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { JOIN_CODE_LENGTH, normalizeJoinCode } from "@/lib/chat/meeting-invites";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";

export function JoinCodeForm({ signedIn }: { signedIn: boolean }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    // A code with a wrong character or length is incomplete rather than wrong
    // while it is being typed, so the button waits instead of the field shouting.
    const ready = normalizeJoinCode(code) !== null;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await joinWithCodeAction(code);
            if (result.to) {
                router.push(result.to);
                return;
            }
            setError(result.error ?? t("meetingCode.notFound"));
        } catch {
            setError(t("meetingCode.notFound"));
        }
        setBusy(false);
    }

    return (
        <PublicShell signedIn={signedIn} className="max-w-md justify-center">
            <Card>
                <CardHeader>
                    <CardTitle>{t("meetingCode.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium">
                                {t("meetingCode.label")}
                                <span className="text-danger"> *</span>
                            </span>
                            <Input
                                autoFocus
                                value={code}
                                autoComplete="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                // Room for the dashes people copy along with it.
                                maxLength={JOIN_CODE_LENGTH + 4}
                                placeholder="ABC-DEF-GHJ" // i18n-ignore: the shape of a code
                                className="font-mono uppercase tracking-wider"
                                aria-invalid={error ? true : undefined}
                                onChange={(event) => {
                                    setCode(event.target.value);
                                    setError("");
                                }}
                            />
                            <span className="text-[0.6875rem] text-muted-foreground">
                                {t("meetingCode.hint")}
                            </span>
                        </label>
                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                        <Button type="submit" disabled={!ready || busy}>
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            {t("meetingCode.join")}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </PublicShell>
    );
}
