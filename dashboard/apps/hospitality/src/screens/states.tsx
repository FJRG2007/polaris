"use client";

/**
 * The two states every hospitality screen can land in before it has data: the venue is not set up
 * yet, or the first load failed. Each says what is wrong and offers the way forward.
 */

import Link from "next/link";
import { useHospitalityT } from "./i18n";
import { Button, EmptyState } from "@polaris/ui";

/** Where a screen lands before the venue is set up: what is missing, and for a manager the way to it. */
export function NoVenue({ manager }: { manager: boolean }) {
    const t = useHospitalityT();
    return (
        <EmptyState
            title={t("service.noFloor")}
            description={manager ? t("service.noFloorHint") : t("service.noFloorAsk")}
            action={manager ? <Button asChild><Link href="/hospitality/menu">{t("service.setUp")}</Link></Button> : undefined}
        />
    );
}

/** A first load that failed: the reason and a retry, instead of a skeleton that never ends. */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
    const t = useHospitalityT();
    return (
        <EmptyState
            title={t("errors.loadFailed")}
            description={message}
            action={<Button variant="outline" onClick={onRetry}>{t("actions.retry")}</Button>}
        />
    );
}
