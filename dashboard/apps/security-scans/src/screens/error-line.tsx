"use client";

/**
 * A failed action in words, and the way out when there is one: a machine whose
 * host service is older than the action (an install not updated since it was
 * added) offers the Polaris update to whoever may run it, and tells anybody
 * else who can.
 */

import { Button } from "@polaris/ui";
import { createContext, useContext } from "react";
import type { SecurityTranslator } from "../lib/i18n";

/** Where Polaris is updated from. */
export const UPDATES_HREF = "/admin/updates";

/** Whether the person on the page may run the Polaris update. */
export const CanUpdateContext = createContext(false);

/** The words for an action's error code; anything unknown is generic. */
export function errorText(t: SecurityTranslator, code: string): string {
    const key = `errors.${code}`;
    return t.has(key) ? t(key) : t("errors.failed");
}

export function ErrorLine({
    t,
    code,
    className = "text-danger"
}: {
    t: SecurityTranslator;
    code: string;
    className?: string;
}) {
    const canUpdate = useContext(CanUpdateContext);
    const outdated = code === "daemonOutdated";
    return (
        <div className="flex flex-wrap items-center gap-2">
            <p className={`min-w-0 ${className}`}>{errorText(t, code)}</p>
            {outdated && canUpdate ? (
                <Button asChild size="sm">
                    <a href={UPDATES_HREF}>{t("errors.updatePolaris")}</a>
                </Button>
            ) : outdated ? (
                <p className="text-sm text-muted-foreground">{t("errors.askToUpdate")}</p>
            ) : null}
        </div>
    );
}
