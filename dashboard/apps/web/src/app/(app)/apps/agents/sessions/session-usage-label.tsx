"use client";

/** What a session spent, from its transcript: tokens, and the estimated cost
 *  when its model has a price. Nothing for one that reported no usage. */

import { Coins } from "lucide-react";
import type { SessionView } from "@/lib/agents/session-service";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function SessionUsageLabel({ usage }: { usage: SessionView["usage"] }) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const total = usage.tokensIn + usage.tokensOut;
    if (total === 0) return null;
    const tokens = format.number(total, { notation: "compact", maximumFractionDigits: 1 });
    const said =
        usage.costUsd === null
            ? t("sessions.usage.tokens", { tokens })
            : t("sessions.usage.tokensCost", {
                  tokens,
                  cost: format.number(usage.costUsd, {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: usage.costUsd < 1 ? 3 : 2
                  })
              });
    const detail = t("sessions.usage.detail", {
        input: format.number(usage.tokensIn),
        output: format.number(usage.tokensOut)
    });
    return (
        <span
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={detail}
            aria-label={`${said}. ${detail}`}
        >
            <Coins className="size-3 shrink-0" />
            {said}
        </span>
    );
}
