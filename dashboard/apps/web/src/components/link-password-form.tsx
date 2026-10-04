"use client";

/**
 * The password gate in front of a protected public link.
 *
 * One form for every kind of link, told which action to submit to: a share, a
 * drop point, a snippet and a text drop point ask the same question and get the
 * same deliberately generic answer, so the form cannot be used to work out which
 * links exist or whether a guess was close.
 *
 * The local cooldown after repeated failures is feedback, not a control: it
 * spares a round trip and says something useful, while the real limit is
 * enforced per link and per address on the server.
 */

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { clearAttempts, cooldownRemaining, recordFailure } from "@/lib/attempt-throttle";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

export function LinkPasswordForm({
    token,
    unlock,
    title,
    description,
    label
}: {
    token: string;
    /** The server action that checks it and sets the unlock cookie. */
    unlock: (token: string, secret: string) => Promise<{ error?: string }>;
    title?: string;
    description?: string;
    label?: string;
}) {
    const t = useTranslations("components");
    const router = useRouter();
    title ??= t("linkPassword.title");
    description ??= t("linkPassword.description");
    label ??= t("linkPassword.label");
    const [secret, setSecret] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        const wait = cooldownRemaining(token);
        if (wait > 0) {
            setError(t("linkPassword.cooldown", { seconds: wait }));
            return;
        }
        startTransition(async () => {
            const result = await unlock(token, secret);
            if (result.error) {
                recordFailure(token);
                setError(result.error);
                return;
            }
            clearAttempts(token);
            router.refresh();
        });
    }

    return (
        <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <PolarisMark className="size-6" />
                <span className="text-sm font-medium">
                    {"Polaris" /* i18n-ignore: the product name */}
                </span>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Lock className="size-4" />
                        {title}
                    </CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">{description}</p>
                        <Input
                            type="password"
                            autoFocus
                            required
                            value={secret}
                            onChange={(event) => setSecret(event.target.value)}
                            placeholder={label}
                            aria-label={label}
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || !secret}>
                            {pending ? t("linkPassword.checking") : t("linkPassword.unlock")}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}
