"use client";

/**
 * "When Polar opens" in Polar's settings: a new chat (the default) or the
 * last one. One preference on the account, read by every place Polar opens -
 * the dashboard's side panel, the browser extension's panel and the Polar
 * page - through `chatOnOpen` (`lib/polar/open-chat.ts`).
 */

import { Select, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { changePolarDisplay, usePolarDisplay } from "@/components/polar/polar-display";

type Opening = "new" | "last";

export function OpeningSettings() {
    const t = useTranslations("polar");
    const toast = useToast();
    const display = usePolarDisplay();
    const value: Opening = display.reopenLastChat ? "last" : "new";
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t("settings.opening.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.opening.intro")}</p>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">{t("settings.opening.label")}</p>
                <Select
                    value={value}
                    aria-label={t("settings.opening.label")}
                    className="w-44"
                    onValueChange={(next) => {
                        if (next === value) return;
                        void changePolarDisplay("reopenLastChat", next === "last").then((saved) =>
                            saved ? undefined : toast.show({ title: t("settings.opening.failed") })
                        );
                    }}
                    options={[
                        { value: "new", label: t("settings.opening.new") },
                        { value: "last", label: t("settings.opening.last") }
                    ]}
                />
            </div>
        </section>
    );
}
