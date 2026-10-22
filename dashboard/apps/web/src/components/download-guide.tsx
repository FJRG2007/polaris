"use client";

/**
 * A download button that opens the install guide for what it downloads, in this
 * dashboard's words. The guide itself is the shared one in `@polaris/ui`, which
 * the public site draws with its own catalog.
 */

import type { ReactNode } from "react";
import { buttonVariants } from "@polaris/ui";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { GuideDownloadLink, type InstallGuideContent } from "@polaris/ui/install-guide";
import { GUIDE_KEY_ROOT, guideSteps, type GuideItem } from "@polaris/ui/install-guide-steps";

/** What the installed thing is called, in every language. */
// i18n-ignore the product's name
const APP_NAME = "Polaris";

/** The guide's words for one item and one file, translated here. */
export function useGuideContent(item: GuideItem, href: string, fileName: string): InstallGuideContent {
    const t = useTranslations("account");
    const key = (rest: string) => `${GUIDE_KEY_ROOT}.${rest}` as NamespaceKey<"account">;
    return {
        title: t(key("title")),
        description: t.rich(key("description"), {
            link: (chunks) => (
                <a key="link" className="underline" href={href} download rel="noreferrer">
                    {chunks}
                </a>
            )
        }),
        fileName,
        appName: APP_NAME,
        doneLabel: t(key("done")),
        steps: guideSteps(item).map((step, index) => ({
            art: step.art,
            label: t(key("step"), { n: index + 1 }),
            title: t(step.titleKey as NamespaceKey<"account">),
            body: t(step.bodyKey as NamespaceKey<"account">, { file: fileName, app: APP_NAME })
        }))
    };
}

export function DownloadWithGuide({
    item,
    href,
    fileName,
    variant = "secondary",
    size,
    children
}: {
    item: GuideItem;
    href: string;
    fileName: string;
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm";
    children: ReactNode;
}) {
    const content = useGuideContent(item, href, fileName);
    return (
        <GuideDownloadLink
            href={href}
            title={fileName}
            content={content}
            className={buttonVariants({ variant, size })}
        >
            {children}
        </GuideDownloadLink>
    );
}
