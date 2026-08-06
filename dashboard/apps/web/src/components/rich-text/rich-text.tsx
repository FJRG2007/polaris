/**
 * Written text, read.
 *
 * The same Markdown the editor saves, drawn as React rather than as HTML that
 * has to be sanitized first: nothing here can inject markup, because no string
 * ever reaches `innerHTML`. It walks the document the editor would have built,
 * so what somebody reads is what the writer saw.
 *
 * Deliberately not marked as a client component, so a screen that already has
 * the text can render it on the server and put it in the first paint. It still
 * works inside a client component, and it stays clear of the editor's schema so
 * that reading never drags ProseMirror into the bundle.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import * as refs from "./references";
import { RICH_TEXT_PROSE } from "./prose";
import { chipClass, chipLabel } from "./chip";
import type { JSONContent } from "@tiptap/core";
import { markdownToDoc, MARKDOWN_BLOCK, REFERENCE } from "./markdown";

export function RichText({ value, className }: { value: string; className?: string }) {
    const doc = markdownToDoc(value);
    if (!value.trim()) return null;
    return <div className={cn(RICH_TEXT_PROSE, className)}>{blocks(doc.content)}</div>;
}

function blocks(nodes: readonly JSONContent[] | undefined): React.ReactNode {
    return (nodes ?? []).map((node, index) => <Block key={index} node={node} />);
}

function Block({ node }: { node: JSONContent }) {
    switch (node.type) {
        case "heading": {
            const level = Number(node.attrs?.level ?? 1);
            const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
            return <Tag>{inline(node.content)}</Tag>;
        }
        case "paragraph":
            return <p>{inline(node.content)}</p>;
        case "blockquote":
            return <blockquote>{blocks(node.content)}</blockquote>;
        case "bulletList":
            return <ul>{listItems(node.content)}</ul>;
        case "orderedList":
            return <ol start={Number(node.attrs?.start ?? 1) || 1}>{listItems(node.content)}</ol>;
        case "taskList":
            // The same attribute the editor's own list carries, so one rule in
            // the shared type styles reaches both.
            return <ul data-type="taskList">{taskItems(node.content)}</ul>;
        case "codeBlock":
        case MARKDOWN_BLOCK:
            return (
                <pre>
                    <code>{text(node)}</code>
                </pre>
            );
        case "horizontalRule":
            return <hr />;
        case "image":
            return <Media node={node} />;
        default:
            return <>{blocks(node.content)}</>;
    }
}

function listItems(nodes: readonly JSONContent[] | undefined): React.ReactNode {
    return (nodes ?? []).map((item, index) => <li key={index}>{blocks(item.content)}</li>);
}

/** A checklist is read, not ticked: the box says what the state is, and the
 *  place to change it is the editor. */
function taskItems(nodes: readonly JSONContent[] | undefined): React.ReactNode {
    return (nodes ?? []).map((item, index) => (
        <li key={index} className="flex items-start gap-2">
            <input
                type="checkbox"
                disabled
                checked={item.attrs?.checked === true}
                aria-label={item.attrs?.checked === true ? "Done" : "Not done"}
                className="mt-1 shrink-0"
            />
            <span className={cn("min-w-0", item.attrs?.checked === true && "text-muted-foreground line-through")}>
                {blocks(item.content)}
            </span>
        </li>
    ));
}

function Media({ node }: { node: JSONContent }) {
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
    if (!src) return null;
    // Not next/image: these point at whatever somebody wrote, which is usually
    // an attachment on this Polaris but can be any address at all.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={String(node.attrs?.alt ?? "")} />;
}

function text(node: JSONContent): string {
    return (node.content ?? []).map((child) => child.text ?? "").join("");
}

function inline(nodes: readonly JSONContent[] | undefined): React.ReactNode {
    return (nodes ?? []).map((node, index) => <Inline key={index} node={node} />);
}

function Inline({ node }: { node: JSONContent }) {
    if (node.type === "hardBreak") return <br />;
    if (node.type === "image") return <Media node={node} />;
    if (node.type === REFERENCE) return <Chip node={node} />;
    if (node.type !== "text") return <>{inline(node.content)}</>;

    let content: React.ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
        if (mark.type === "bold") content = <strong>{content}</strong>;
        else if (mark.type === "italic") content = <em>{content}</em>;
        else if (mark.type === "strike") content = <s>{content}</s>;
        else if (mark.type === "code") content = <code>{content}</code>;
        else if (mark.type === "link") content = <Anchor href={String(mark.attrs?.href ?? "")}>{content}</Anchor>;
    }
    return <>{content}</>;
}

/** An outside link opens away from Polaris and cannot reach back into it. */
function Anchor({ href, children }: { href: string; children: React.ReactNode }) {
    if (href.startsWith("/")) return <Link href={href}>{children}</Link>;
    return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
        </a>
    );
}

function Chip({ node }: { node: JSONContent }) {
    const kind = node.attrs?.kind as refs.ReferenceKind;
    const id = String(node.attrs?.id ?? "");
    const label = chipLabel(kind, String(node.attrs?.label ?? ""));
    const href = refs.referenceHref(kind, id);
    if (!href) return <span className={chipClass(kind)}>{label}</span>;
    return (
        <Link href={href} className={cn(chipClass(kind), "no-underline hover:bg-muted-foreground/20")}>
            {label}
        </Link>
    );
}
