"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { QuickPinInput, pinReady } from "@/components/quick-pin-input";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { unlockAppAction } from "./actions";

export function AppUnlockView({
    appId,
    label,
    next,
    pinLength
}: {
    appId: string;
    label: string;
    next: string;
    pinLength: number | null;
}) {
    const router = useRouter();
    const t = useTranslations("nav");
    const tAuth = useTranslations("auth");
    const navLabel = useNavLabel();
    const [pin, setPin] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const box = useRef<HTMLInputElement>(null);
    // One check per PIN: the last digit and the button can both ask.
    const checking = useRef(false);
    const whole = pinReady(pin, pinLength);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!whole || checking.current) return;
        checking.current = true;
        setPending(true);
        setError(null);
        const result = await unlockAppAction({ appId, pin }).catch(() => ({
            error: t("appLock.failed")
        }));
        setPending(false);
        checking.current = false;
        if (result.error) {
            setError(result.error);
            setPin("");
            box.current?.focus();
            return;
        }
        router.replace(next);
        router.refresh();
    }

    return (
        <main className="grid min-h-[60dvh] place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center gap-2">
                    <Lock className="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <CardTitle className="min-w-0 truncate">
                        {t("appLock.title", { app: navLabel(label) })}
                    </CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="mb-3 text-center text-sm text-muted-foreground">
                        {t("appLock.description")}
                    </p>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {tAuth("lock.pin")}
                            <QuickPinInput
                                ref={box}
                                name="pin"
                                autoFocus
                                length={pinLength}
                                value={pin}
                                readOnly={pending}
                                onValueChange={setPin}
                                required
                            />
                        </label>
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                        <Button type="submit" disabled={pending || !whole}>
                            {pending ? tAuth("lock.unlocking") : tAuth("lock.unlock")}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </main>
    );
}
