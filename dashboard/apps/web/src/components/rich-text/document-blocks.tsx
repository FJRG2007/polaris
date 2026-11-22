"use client";

/**
 * Formulas and diagrams, drawn from the source a fence or a `` $`...`$ `` holds.
 *
 * Both libraries are large, so each is its own chunk, fetched the first time a
 * block on screen asks for it. Until it lands the source is shown as text, which
 * is also what is shown when the source has a mistake in it - a formula that
 * does not parse is never a blank space.
 *
 * KaTeX runs with `trust` off (see `katex-render`) and Mermaid with its strict
 * security level, which sanitizes the SVG it returns and refuses click handlers
 * and HTML labels, so the markup either one hands back is safe to set.
 */

import { pageIsDark } from "@/lib/page-theme";
import type { OutlineEntry, RenderedFence } from "./outline";
import { useEffect, useId, useState } from "react";
import { cn, CopyIcon, useCopied } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

let katexChunk: Promise<typeof import("./katex-render")> | null = null;

function useMath(latex: string, display: boolean): string | null {
    const [html, setHtml] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        katexChunk ??= import("./katex-render");
        void katexChunk
            .then((chunk) => {
                if (alive) setHtml(chunk.renderMath(latex, display));
            })
            .catch(() => {
                katexChunk = null;
            });
        return () => {
            alive = false;
        };
    }, [latex, display]);
    return html;
}

/** A formula, inline in a sentence or on a line of its own. */
export function Formula({ latex, display = false }: { latex: string; display?: boolean }) {
    const html = useMath(latex, display);
    if (html === null) {
        return display ? (
            <pre className="overflow-x-auto font-mono text-xs">{latex}</pre>
        ) : (
            <code>{latex}</code>
        );
    }
    const Tag = display ? "div" : "span";
    return (
        <Tag
            data-math=""
            className={cn(display && "overflow-x-auto py-1 text-center")}
            // KaTeX's own markup, rendered with `trust` off: see katex-render.
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

type Mermaid = (typeof import("mermaid"))["default"];
let mermaidChunk: Promise<Mermaid> | null = null;
let mermaidTheme: string | null = null;

async function loadMermaid(): Promise<Mermaid> {
    mermaidChunk ??= import("mermaid").then((module) => module.default);
    const mermaid = await mermaidChunk;
    const theme = pageIsDark() ? "dark" : "default";
    if (mermaidTheme !== theme) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
        mermaidTheme = theme;
    }
    return mermaid;
}

type DiagramState = { readonly svg: string } | { readonly failed: true } | null;

/** A Mermaid diagram, redrawn a moment after its source stops changing. */
export function Diagram({ code }: { code: string }) {
    const t = useTranslations("components");
    const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
    const [state, setState] = useState<DiagramState>(null);

    useEffect(() => {
        let alive = true;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const mermaid = await loadMermaid();
                    // Parsed first: a failed render leaves its error drawing in
                    // the page, a failed parse leaves nothing.
                    const valid = await mermaid.parse(code, { suppressErrors: true });
                    if (!valid) {
                        if (alive) setState({ failed: true });
                        return;
                    }
                    const { svg } = await mermaid.render(id, code);
                    if (alive) setState({ svg });
                } catch {
                    if (alive) setState({ failed: true });
                }
            })();
        }, 250);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [code, id]);

    if (state && "svg" in state) {
        return (
            <div
                data-diagram=""
                className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
                // Mermaid's SVG, sanitized by its strict security level.
                dangerouslySetInnerHTML={{ __html: state.svg }}
            />
        );
    }
    if (state && "failed" in state) {
        return <p className="text-xs text-danger-ink">{t("editor.diagramError")}</p>;
    }
    return <p className="text-xs text-muted-foreground">{t("editor.diagramLoading")}</p>;
}

/** What a rendered fence draws, without any chrome. */
export function FenceRender({ code, fence }: { code: string; fence: RenderedFence }) {
    if (!code.trim()) return null;
    return fence === "math" ? <Formula latex={code} display /> : <Diagram code={code} />;
}

/** A ```math or ```mermaid fence, as it is read: the drawing, and its source to
 *  copy or look at. */
export function RenderedFenceBlock({ code, fence }: { code: string; fence: RenderedFence }) {
    const t = useTranslations("components");
    const [source, setSource] = useState(false);
    const { copied, copy } = useCopied();

    return (
        <div className="my-1 overflow-hidden rounded-md border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-2.5 py-1">
                <span className="truncate font-mono text-[0.625rem] uppercase tracking-[0.06em] text-foreground-subtle">
                    {fence === "math" ? t("editor.mathLanguage") : t("editor.diagramLanguage")}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        aria-pressed={source}
                        onClick={() => setSource((open) => !open)}
                        className="rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-card-hover hover:text-foreground"
                    >
                        {source ? t("editor.showDrawing") : t("editor.showSource")}
                    </button>
                    <button
                        type="button"
                        title={t("editor.copyCode")}
                        aria-label={t("editor.copyCode")}
                        onClick={() => void copy(code)}
                        className={cn(
                            "rounded p-1",
                            copied
                                ? "text-success"
                                : "text-muted-foreground hover:bg-card-hover hover:text-foreground"
                        )}
                    >
                        <CopyIcon copied={copied} />
                    </button>
                </div>
            </div>
            {source ? (
                <pre className="overflow-x-auto bg-surface p-3 font-mono text-xs leading-relaxed">
                    <code>{code}</code>
                </pre>
            ) : (
                <div className="p-3">
                    <FenceRender code={code} fence={fence} />
                </div>
            )}
        </div>
    );
}

/** The list a table of contents draws, for both the editor and the reader. */
export function OutlineList({
    outline,
    onPick
}: {
    outline: readonly OutlineEntry[];
    onPick?: (entry: OutlineEntry) => void;
}) {
    const t = useTranslations("components");
    return (
        <nav aria-label={t("editor.tableOfContents")} className="rounded-md border border-border px-3 py-2 text-sm">
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.06em] text-foreground-subtle">
                {t("editor.tableOfContents")}
            </p>
            {outline.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("editor.tableOfContentsEmpty")}</p>
            ) : (
                <ul className="m-0 list-none space-y-0.5 p-0">
                    {outline.map((entry) => (
                        <li key={entry.id} className="m-0 p-0" style={{ paddingInlineStart: `${(entry.level - 1) * 0.875}rem` }}>
                            <a
                                href={`#${entry.id}`}
                                onClick={(event) => {
                                    if (!onPick) return;
                                    event.preventDefault();
                                    onPick(entry);
                                }}
                                className="block min-w-0 truncate text-muted-foreground no-underline hover:text-foreground"
                                title={entry.text}
                            >
                                {entry.text || t("editor.untitledHeading")}
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </nav>
    );
}
