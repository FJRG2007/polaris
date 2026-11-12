"use client";

/**
 * The unlock form. Defaults to the PIN when one is set - that is the whole point
 * of having it - with the password always available underneath, so a forgotten
 * PIN never becomes a dead end.
 */

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signOut } from "@/lib/auth-client";
import { unlockSessionAction } from "./actions";
import { QuickPinInput, pinReady } from "@/components/quick-pin-input";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function LockView({
    name,
    email,
    hasPin,
    pinLength
}: {
    name: string;
    email: string;
    hasPin: boolean;
    pinLength: number | null;
}) {
    const router = useRouter();
    const t = useTranslations("auth");
    const [method, setMethod] = useState<"pin" | "password">(hasPin ? "pin" : "password");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pin, setPin] = useState("");
    const box = useRef<HTMLInputElement>(null);
    // One check per PIN: the last digit and the button can both ask.
    const checking = useRef(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const secret = method === "pin" ? pin : String(new FormData(event.currentTarget).get("secret") ?? "");
        if (checking.current || (method === "pin" && !pinReady(pin, pinLength))) return;
        checking.current = true;
        setPending(true);
        setError(null);
        const result = await unlockSessionAction(secret, method);
        setPending(false);
        checking.current = false;
        if (result.error) {
            setError(result.error);
            if (method === "pin") {
                setPin("");
                box.current?.focus();
            }
            return;
        }
        router.push("/");
        router.refresh();
    }

    async function onSignOut() {
        setError(null);
        const refused = await signOut();
        if (refused) setError(refused);
    }

    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("lock.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="mb-3 text-center text-sm text-muted-foreground">
                        {name} <span className="block truncate text-xs">{email}</span>
                    </p>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {method === "pin" ? t("lock.pin") : t("lock.password")}
                            {method === "pin" ? (
                                <QuickPinInput
                                    ref={box}
                                    name="secret"
                                    autoFocus
                                    length={pinLength}
                                    value={pin}
                                    readOnly={pending}
                                    onValueChange={setPin}
                                    required
                                />
                            ) : (
                                <Input
                                    name="secret"
                                    type="password"
                                    autoFocus
                                    autoComplete="current-password"
                                    required
                                />
                            )}
                        </label>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || (method === "pin" && !pinReady(pin, pinLength))}>
                            {pending ? t("lock.unlocking") : t("lock.unlock")}
                        </Button>
                    </form>
                    <div className="mt-4 flex justify-between text-xs">
                        {hasPin ? (
                            <button
                                type="button"
                                className="text-muted-foreground underline-offset-2 hover:underline"
                                onClick={() => {
                                    setMethod(method === "pin" ? "password" : "pin");
                                    setPin("");
                                    setError(null);
                                }}
                            >
                                {method === "pin" ? t("lock.usePassword") : t("lock.usePin")}
                            </button>
                        ) : (
                            <span />
                        )}
                        <button
                            type="button"
                            className="text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => void onSignOut()}
                        >
                            {t("lock.signOut")}
                        </button>
                    </div>
                </CardBody>
            </Card>
        </main>
    );
}
