"use client";

/**
 * Waiting for another session to approve this sign-in. Polls by refreshing the
 * route, so the server decides when the wait is over and the page never holds an
 * opinion about the session's state.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ShieldQuestion } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { signOut } from "@/lib/auth-client";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How often to ask whether the decision has been made. */
const POLL_MS = 5000;

export function PendingView({ requestedAt }: { requestedAt: string }) {
    const router = useRouter();
    const t = useTranslations("auth");

    useEffect(() => {
        const timer = window.setInterval(() => router.refresh(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [router]);

    async function onCancel() {
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("pending.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col items-center gap-3 text-center">
                    <ShieldQuestion className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t("pending.body")}</p>
                    <p className="text-xs text-muted-foreground">
                        {t.rich("pending.requested", { time: <RelativeTime key="time" iso={requestedAt} /> })}
                    </p>
                    <button
                        type="button"
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => void onCancel()}
                    >
                        {t("pending.cancel")}
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}
