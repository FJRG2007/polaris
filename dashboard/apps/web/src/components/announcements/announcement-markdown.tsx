/**
 * An announcement's text, drawn from parsed tokens as React elements - never as
 * HTML - so nothing typed into it can become markup. Hook-free, so the banner,
 * the compose preview and a server component can all use it.
 */

import Link from "next/link";
import { Fragment } from "react";
import { parseMarkdown, type Inline } from "@/lib/announcements/markdown";

function InlineText({ parts }: { parts: Inline[] }) {
    return (
        <>
            {parts.map((part, index) => {
                if (part.kind === "bold") return <strong key={index}>{part.text}</strong>;
                if (part.kind === "italic") return <em key={index}>{part.text}</em>;
                if (part.kind === "code") {
                    return (
                        <code key={index} className="rounded bg-black/10 px-1 text-[0.9em] dark:bg-white/10">
                            {part.text}
                        </code>
                    );
                }
                if (part.kind === "link") {
                    return part.href.startsWith("/") ? (
                        <Link key={index} href={part.href} className="underline underline-offset-2">
                            {part.text}
                        </Link>
                    ) : (
                        <a
                            key={index}
                            href={part.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2"
                        >
                            {part.text}
                        </a>
                    );
                }
                return <Fragment key={index}>{part.text}</Fragment>;
            })}
        </>
    );
}

export function AnnouncementMarkdown({ source, className }: { source: string; className?: string }) {
    const blocks = parseMarkdown(source);
    if (blocks.length === 0) return null;
    return (
        <div className={className}>
            {blocks.map((block, index) =>
                block.kind === "list" ? (
                    <ul key={index} className="ml-4 list-disc">
                        {block.items.map((item, at) => (
                            <li key={at}>
                                <InlineText parts={item} />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p key={index} className="break-words [&:not(:first-child)]:mt-1">
                        {block.lines.map((line, at) => (
                            <Fragment key={at}>
                                {at > 0 ? <br /> : null}
                                <InlineText parts={line} />
                            </Fragment>
                        ))}
                    </p>
                )
            )}
        </div>
    );
}
