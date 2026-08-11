import { Reveal } from "../reveal";
import { LEGAL_UPDATED } from "@/lib/legal/documents";
import type { LegalDocument } from "@/lib/legal/documents";

/** One legal page, rendered the same way whichever document it is. Prose only:
 *  these are read by people and by review desks, and neither wants chrome. */
export function LegalDocumentView({ document }: { document: LegalDocument }) {
    return (
        <article className="flex flex-col gap-14">
            <Reveal className="flex flex-col gap-3">
                <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
                    {document.title} <span className="text-muted-foreground">- Polaris</span>
                </h1>
                <p className="text-lg leading-relaxed text-muted-foreground">{document.summary}</p>
                <p className="text-xs text-muted-foreground">Last updated {LEGAL_UPDATED}.</p>
            </Reveal>

            {document.sections.map((section) => (
                <Reveal key={section.heading} className="flex flex-col gap-3">
                    <h2 className="text-xl font-medium tracking-tight">{section.heading}</h2>
                    {section.body.map((paragraph) => (
                        <p key={paragraph} className="text-base leading-relaxed text-muted-foreground">
                            {paragraph}
                        </p>
                    ))}
                </Reveal>
            ))}
        </article>
    );
}
