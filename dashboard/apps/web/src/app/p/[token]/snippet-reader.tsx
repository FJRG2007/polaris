"use client";

/**
 * Reading a shared snippet.
 *
 * Three things happen here that cannot happen on the server. A one-time snippet
 * is only spent when somebody presses the button, so the request that opens it
 * comes from here. A sealed snippet is decrypted here, with the key out of the
 * URL fragment, which is the one part of a URL the browser never sends. And
 * copying a file is a clipboard write, which is the whole point of a paste.
 */

import { useEffect, useState } from "react";
import { CodeSurface } from "@/components/code-surface";
import { PublicShell } from "@/components/public-shell";
import { Button, Card, CardBody, cn } from "@polaris/ui";
import { keyFromFragment, unseal } from "@/lib/browser-seal";
import { Check, Copy, Download, EyeOff, FileCode, Flame, Loader2 } from "lucide-react";
import {
    openBurnSnippetAction,
    type PublicSnippetFile
} from "@/app/(app)/drive/snippets/snippet-actions";

export function SnippetReader({
    token,
    title,
    description,
    sealed,
    signedIn,
    files,
    oneTime = false
}: {
    token: string;
    title: string;
    description: string | null;
    sealed: boolean;
    signedIn: boolean;
    /** Null when the text has not been fetched yet - a one-time snippet. */
    files: PublicSnippetFile[] | null;
    oneTime?: boolean;
}) {
    const [shown, setShown] = useState<PublicSnippetFile[] | null>(files);
    const [active, setActive] = useState(0);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [opening, setOpening] = useState(!oneTime && sealed);

    // A sealed snippet arrives as ciphertext. The key is in the fragment, so the
    // decryption can only happen after mount - the server never sees either.
    useEffect(() => {
        if (!sealed || files === null) return;
        let live = true;
        void (async () => {
            const key = keyFromFragment();
            if (!key) {
                if (live) {
                    setError("This link is incomplete. The part after the # is the key it needs.");
                    setOpening(false);
                }
                return;
            }
            const opened = await Promise.all(
                files.map(async (file) => ({ ...file, body: (await unseal(file.body, key)) ?? "" }))
            );
            if (!live) return;
            if (opened.some((file) => file.body === "")) {
                setError("This link could not be opened. Its key does not match.");
            } else {
                setShown(opened);
            }
            setOpening(false);
        })();
        return () => {
            live = false;
        };
    }, [sealed, files]);

    async function onOpenOnce() {
        setPending(true);
        setError(null);
        const result = await openBurnSnippetAction(token);
        if (result.error || !result.files) {
            setPending(false);
            setError(result.error ?? "This link is no longer available.");
            return;
        }
        if (!sealed) {
            setShown(result.files);
            setPending(false);
            return;
        }
        const key = keyFromFragment();
        if (!key) {
            setPending(false);
            setError("This link is incomplete. The part after the # is the key it needs.");
            return;
        }
        const opened = await Promise.all(
            result.files.map(async (file) => ({
                ...file,
                body: (await unseal(file.body, key)) ?? ""
            }))
        );
        setShown(opened);
        setPending(false);
    }

    async function onCopy(file: PublicSnippetFile) {
        await navigator.clipboard.writeText(file.body);
        setCopied(file.name);
        window.setTimeout(() => setCopied(null), 2000);
    }

    function onDownload(file: PublicSnippetFile) {
        const blob = new Blob([file.body], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    const current = shown?.[active] ?? shown?.[0] ?? null;

    return (
        <PublicShell signedIn={signedIn} className="max-w-4xl">
            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                    <h1 className="flex items-center gap-2 truncate text-[17px] font-semibold tracking-tight">
                        {title}
                        {sealed ? (
                            <EyeOff className="size-4 text-muted-foreground" aria-label="Sealed" />
                        ) : null}
                    </h1>
                    {description ? (
                        <p className="text-sm text-muted-foreground">{description}</p>
                    ) : null}
                </div>
            </div>

            {shown === null ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-3 p-8 text-center">
                        <Flame className="size-5 text-muted-foreground" />
                        <div>
                            <p className="text-sm font-medium">This can only be opened once</p>
                            <p className="text-sm text-muted-foreground">
                                Opening it deletes it. Make sure you can keep what is inside before
                                you do.
                            </p>
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button onClick={onOpenOnce} disabled={pending}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            Open it
                        </Button>
                    </CardBody>
                </Card>
            ) : opening ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">
                        Opening it in your browser...
                    </CardBody>
                </Card>
            ) : error ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-danger">{error}</CardBody>
                </Card>
            ) : current ? (
                <Card>
                    <CardBody className="flex flex-col gap-0 p-0">
                        <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
                            {shown.map((file, index) => (
                                <Button
                                    key={file.name + index}
                                    size="sm"
                                    variant={index === active ? "secondary" : "ghost"}
                                    onClick={() => setActive(index)}
                                    className={cn(shown.length === 1 && "pointer-events-none")}
                                >
                                    {file.name}
                                </Button>
                            ))}
                            <div className="ml-auto flex items-center gap-1">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    title="Copy"
                                    aria-label={`Copy ${current.name}`}
                                    onClick={() => onCopy(current)}
                                >
                                    {copied === current.name ? (
                                        <Check className="size-4 text-success" />
                                    ) : (
                                        <Copy className="size-4" />
                                    )}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    title="Download"
                                    aria-label={`Download ${current.name}`}
                                    onClick={() => onDownload(current)}
                                >
                                    <Download className="size-4" />
                                </Button>
                                {/* The reason a paste is useful from a terminal.
                                    A sealed or one-time snippet has no raw form,
                                    so it is not offered rather than 409ing. */}
                                {!sealed && !oneTime ? (
                                    <Button
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        title="Open the raw text"
                                    >
                                        <a
                                            href={`/p/${token}/raw?f=${encodeURIComponent(current.name)}`}
                                            aria-label={`Raw text of ${current.name}`}
                                        >
                                            <FileCode className="size-4" />
                                        </a>
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        <div className="max-h-[70vh] overflow-hidden">
                            <CodeSurface code={current.body} language={current.language || null} />
                        </div>
                    </CardBody>
                </Card>
            ) : null}

            {oneTime && shown !== null ? (
                <p className="text-center text-xs text-muted-foreground">
                    This snippet has been deleted. Closing this page loses it.
                </p>
            ) : null}
        </PublicShell>
    );
}
