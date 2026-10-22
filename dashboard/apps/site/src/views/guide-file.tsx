"use client";

/**
 * A released file's download button. A file somebody installs by hand opens
 * the same install guide the dashboard shows, in the site's language.
 */

import { Download } from "lucide-react";
import { buttonVariants } from "@polaris/ui";
import { guideSteps } from "@polaris/ui/install-guide-steps";
import { GuideDownloadLink } from "@polaris/ui/install-guide";
import { fill, type GuideItemId, type GuideWords } from "@/data/builders";

/** The description's `<link>` tag becomes the link that downloads the file again. */
function withLink(message: string, href: string) {
    const match = /^(.*)<link>(.*)<\/link>(.*)$/s.exec(message);
    if (!match) return message;
    return (
        <>
            {match[1]}
            <a className="underline" href={href} download rel="noreferrer">
                {match[2]}
            </a>
            {match[3]}
        </>
    );
}

export function GuideFile({
    item,
    href,
    fileName,
    label,
    guide
}: {
    item: GuideItemId | null;
    href: string;
    fileName: string;
    label: string;
    guide: GuideWords;
}) {
    const className = buttonVariants({ variant: "secondary", size: "sm" });
    const body = (
        <>
            <Download className="size-4" /> {label}
        </>
    );
    if (!item) {
        return (
            <a href={href} download rel="noreferrer" className={className} title={fileName}>
                {body}
            </a>
        );
    }
    return (
        <GuideDownloadLink
            href={href}
            title={fileName}
            className={className}
            content={{
                title: guide.title,
                description: withLink(guide.description, href),
                fileName,
                // i18n-ignore the product's name
                appName: "Polaris",
                doneLabel: guide.done,
                steps: guideSteps(item).map((step, index) => ({
                    art: step.art,
                    label: fill(guide.step, { n: index + 1 }),
                    title: guide.steps[step.id] ?? step.id,
                    body: fill(guide.items[item]?.[step.id] ?? "", {
                        file: fileName,
                        app: "Polaris"
                    })
                }))
            }}
        >
            {body}
        </GuideDownloadLink>
    );
}
