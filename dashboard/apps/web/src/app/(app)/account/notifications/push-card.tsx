"use client";

/**
 * Notices on this device with Polaris closed (Web Push). Subscribing is per
 * device and per browser, so the card reads this browser's own subscription
 * and says what it is; nothing here is stored on the account but the
 * subscription itself.
 */

import { useEffect, useState, useTransition } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { pushKeyAction, subscribePushAction, unsubscribePushAction } from "./actions";

type Standing = "unsupported" | "denied" | "off" | "on";

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
    const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    const raw = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
}

function supported(): boolean {
    return (
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
    );
}

async function registration(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return navigator.serviceWorker.ready;
}

export function PushCard() {
    const t = useTranslations("accountNotifications");
    const [standing, setStanding] = useState<Standing>("unsupported");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (!supported()) return;
        if (Notification.permission === "denied") {
            setStanding("denied");
            return;
        }
        void registration()
            .then((worker) => worker.pushManager.getSubscription())
            .then((current) => setStanding(current ? "on" : "off"))
            .catch(() => setStanding("off"));
    }, []);

    function turnOn() {
        setError(null);
        startTransition(async () => {
            try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                    setStanding(permission === "denied" ? "denied" : "off");
                    return;
                }
                const key = await pushKeyAction();
                if (!key.key) throw new Error(key.error);
                const worker = await registration();
                const subscription = await worker.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: keyBytes(key.key)
                });
                const saved = await subscribePushAction(subscription.toJSON());
                if (saved.error) {
                    await subscription.unsubscribe().catch(() => undefined);
                    throw new Error(saved.error);
                }
                setStanding("on");
            } catch {
                setError(t("push.failed"));
            }
        });
    }

    function turnOff() {
        setError(null);
        const previous = standing;
        setStanding("off");
        startTransition(async () => {
            try {
                const worker = await registration();
                const current = await worker.pushManager.getSubscription();
                if (current) {
                    await unsubscribePushAction(current.endpoint);
                    await current.unsubscribe();
                }
            } catch {
                setStanding(previous);
                setError(t("push.failed"));
            }
        });
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t("push.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("push.description")}</p>
                </div>
                {standing === "on" ? (
                    <Button size="sm" variant="outline" onClick={turnOff} disabled={pending}>
                        {t("push.turnOff")}
                    </Button>
                ) : standing === "off" ? (
                    <Button size="sm" onClick={turnOn} disabled={pending}>
                        {t("push.turnOn")}
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="space-y-1">
                <p className="text-sm">{t(`push.standing.${standing}`)}</p>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
