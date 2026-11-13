"use client";

/**
 * "Copy page" beside a docs page's title: the button copies the page as
 * Markdown, and its menu also hands the page to an assistant. The Markdown is
 * the file the build wrote beside the page, so what is copied is what an
 * assistant reading the address gets, with the reader's own Polaris in it.
 */

import { useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    ToastProvider,
    useToast
} from "@polaris/ui";
import { withReaderOrigin } from "@/lib/example-origin";
import { useReaderOrigin } from "@/components/example-host";
import { ClaudeMark, OpenAiMark } from "@polaris/ui/account-downloads/model-marks";

export interface PageActionsWords {
    readonly copyPage: string;
    readonly pageActions: string;
    readonly copyMarkdown: string;
    readonly copyMarkdownHint: string;
    readonly openClaude: string;
    readonly openChatGpt: string;
    readonly askHint: string;
    readonly copied: string;
    readonly copyFailed: string;
    /** "Read {url} so I can ask you questions about it." */
    readonly prompt: string;
}

/** Where an assistant opens with a question already typed. */
export function assistantLinks(prompt: string): { claude: string; chatgpt: string } {
    const q = encodeURIComponent(prompt);
    return {
        claude: `https://claude.ai/new?q=${q}`,
        chatgpt: `https://chatgpt.com/?hints=search&q=${q}`
    };
}

export function PageActions(props: {
    /** The page's Markdown, under the site's base path. */
    markdown: string;
    /** The page's absolute address, for the assistant to read. */
    url: string;
    words: PageActionsWords;
}) {
    return (
        <ToastProvider>
            <Actions {...props} />
        </ToastProvider>
    );
}

function Actions({
    markdown,
    url,
    words
}: {
    markdown: string;
    url: string;
    words: PageActionsWords;
}) {
    const origin = useReaderOrigin();
    const toast = useToast();
    const [copied, setCopied] = useState(false);
    const links = assistantLinks(words.prompt.replace("{url}", url));

    async function copy() {
        try {
            const response = await fetch(markdown);
            if (!response.ok) throw new Error(`${response.status}`);
            await navigator.clipboard.writeText(withReaderOrigin(await response.text(), origin));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
            toast.show({ key: "copy-page", title: words.copied, life: 3000 });
        } catch {
            toast.show({ key: "copy-page", title: words.copyFailed, life: 5000 });
        }
    }

    return (
        <div className="flex shrink-0 items-stretch">
            <Button
                variant="outline"
                size="sm"
                onClick={() => void copy()}
                className="gap-1.5 rounded-r-none border-r-0"
            >
                {copied ? (
                    <Check className="size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                    <Copy className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {words.copyPage}
            </Button>
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={words.pageActions}
                        title={words.pageActions}
                        className="h-7 rounded-l-none"
                    >
                        <ChevronDown className="size-3.5" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem onSelect={() => void copy()} className="items-start">
                        <Copy className="mt-0.5" aria-hidden="true" />
                        <MenuText title={words.copyMarkdown} hint={words.copyMarkdownHint} />
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild className="items-start">
                        <a href={links.claude} target="_blank" rel="noopener noreferrer">
                            <ClaudeMark className="mt-0.5 size-4" />
                            <MenuText title={words.openClaude} hint={words.askHint} />
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild className="items-start">
                        <a href={links.chatgpt} target="_blank" rel="noopener noreferrer">
                            <OpenAiMark className="mt-0.5 size-4" />
                            <MenuText title={words.openChatGpt} hint={words.askHint} />
                        </a>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function MenuText({ title, hint }: { title: string; hint: string }) {
    return (
        <span className="flex min-w-0 flex-col">
            <span className="truncate" title={title}>{title}</span>
            <span className="truncate text-xs text-muted-foreground" title={hint}>{hint}</span>
        </span>
    );
}
