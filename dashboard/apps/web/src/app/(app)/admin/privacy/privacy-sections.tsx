"use client";

/**
 * The privacy screen's layout: one heading and one line per group, so a group
 * reads before its controls have loaded. Shared by the loaded page and its
 * skeleton, which is why the headings never wait on the data.
 */

import type { ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

function Section({ id, children }: { id: "profiles" | "discovery"; children: ReactNode }) {
    const t = useTranslations("admin");
    return (
        <section aria-labelledby={`privacy-${id}`} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
                <h2 id={`privacy-${id}`} className="text-sm font-medium">
                    {t(`privacy.${id}.title`)}
                </h2>
                <p className="text-sm text-muted-foreground">{t(`privacy.${id}.description`)}</p>
            </div>
            {children}
        </section>
    );
}

export function PrivacySections({
    profiles,
    discovery
}: {
    profiles: ReactNode;
    discovery: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-8">
            <Section id="profiles">{profiles}</Section>
            <Section id="discovery">{discovery}</Section>
        </div>
    );
}
