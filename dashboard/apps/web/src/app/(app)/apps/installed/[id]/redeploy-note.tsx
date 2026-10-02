"use client";

/**
 * One line under an installed app's header: whether pressing Redeploy takes it
 * away for a moment, and why. The same decision the deploy acts on, read from
 * Deploy; nothing is shown when it cannot be read, rather than a guess.
 */

import { useEffect, useState } from "react";
import type { DeployStrategy } from "@/lib/deploy/releases";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { redeployStrategyAction } from "./actions";

export function RedeployNote({
    installId,
    applicationId
}: {
    installId: string;
    applicationId: string | null;
}) {
    const t = useTranslations("installed");
    const [strategy, setStrategy] = useState<DeployStrategy | null>(null);

    useEffect(() => {
        if (!applicationId) return;
        let active = true;
        void redeployStrategyAction(installId)
            .then((result) => {
                if (active) setStrategy(result);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [installId, applicationId]);

    if (!strategy) return null;
    if (strategy.mode !== "restart")
        return <p className="text-xs text-muted-foreground">{t("deployGap.none")}</p>;
    const port = strategy.reasons.find((reason) => reason.code === "hostPort");
    const volumes = strategy.reasons.find((reason) => reason.code === "volumes");
    return (
        <p className="text-xs text-muted-foreground">
            {port && port.code === "hostPort"
                ? t("deployGap.hostPort", {
                      port: port.port,
                      protocol: port.protocol.toUpperCase()
                  })
                : volumes && volumes.code === "volumes"
                  ? t("deployGap.volumes", { names: volumes.names.join(", ") })
                  : t("deployGap.other")}
        </p>
    );
}
