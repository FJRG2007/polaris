"use client";

/**
 * Writing a snippet: a title, an optional note, and one or more named files with
 * their own language and their own painted editor.
 *
 * The same component writes a new snippet and edits an existing one, because
 * they are the same screen with a different verb - the only real difference is
 * that a new one can be shared as it is saved, and an existing one already has
 * its own sharing controls on the page.
 *
 * Sealing is offered only when writing: it encrypts every file here, in the
 * browser, under a key that goes in the link's fragment and never reaches the
 * server. That cannot be turned on later without re-sending the link, so it is
 * not offered as an edit.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CodeSurface } from "@/components/code-surface";
import { useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Loader2, Plus, Save, X } from "lucide-react";
import { CODE_LANGUAGES, languageForFile } from "@/lib/code-language";
import { generateSealKey, seal, withSealKey } from "@/lib/browser-seal";
import { MAX_SNIPPET_FILES, MAX_SNIPPET_TOTAL_CHARS } from "@polaris/core";
import { createSnippetAction, updateSnippetAction } from "./snippet-actions";
import { Button, Card, CardBody, Input, Select, Textarea } from "@polaris/ui";

export interface EditorFile {
    name: string;
    language: string;
    body: string;
}

export interface EditorSnippet {
    id: string;
    title: string;
    description: string | null;
    files: EditorFile[];
}

/** "Detect from the name" plus every grammar, for the per-file picker. */
const LANGUAGE_OPTIONS = [
    { value: "", label: "Plain text" },
    ...CODE_LANGUAGES.map((language) => ({ value: language.id, label: language.label }))
];

const VISIBILITY_OPTIONS = [
    { value: "private", label: "Private - only you" },
    { value: "link", label: "Anyone with the link" }
];

function emptyFile(index: number): EditorFile {
    return { name: index === 0 ? "snippet.txt" : `file-${index + 1}.txt`, language: "", body: "" };
}

export function SnippetEditor({ snippet }: { snippet?: EditorSnippet }) {
    const router = useRouter();
    const editing = snippet !== undefined;
    const [title, setTitle] = useState(snippet?.title ?? "");
    const [description, setDescription] = useState(snippet?.description ?? "");
    const [files, setFiles] = useState<EditorFile[]>(snippet?.files ?? [emptyFile(0)]);
    const [active, setActive] = useState(0);
    const [visibility, setVisibility] = useState("private");
    const [sealed, setSealed] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const current = files[active] ?? files[0]!;
    const used = useMemo(() => files.reduce((total, file) => total + file.body.length, 0), [files]);

    function patchFile(index: number, patch: Partial<EditorFile>): void {
        setFiles((prev) => prev.map((file, at) => (at === index ? { ...file, ...patch } : file)));
    }

    function addFile(): void {
        setFiles((prev) => {
            if (prev.length >= MAX_SNIPPET_FILES) return prev;
            setActive(prev.length);
            return [...prev, emptyFile(prev.length)];
        });
    }

    function removeFile(index: number): void {
        setFiles((prev) => (prev.length === 1 ? prev : prev.filter((_, at) => at !== index)));
        setActive((prev) => (prev >= index && prev > 0 ? prev - 1 : prev));
    }

    /**
     * The language a file is painted in: what was picked, or what its name
     * suggests. Guessing from the name is what makes pasting an .env into a file
     * called `.env` do the right thing without a second decision.
     */
    function languageOf(file: EditorFile): string {
        return file.language || (languageForFile(file.name)?.id ?? "");
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (used > MAX_SNIPPET_TOTAL_CHARS) {
            setError("This snippet is too large.");
            return;
        }
        if (files.some((file) => file.body.trim() === "")) {
            setError("Every file needs something in it.");
            return;
        }

        setPending(true);
        setError(null);

        // Sealing happens before anything leaves the browser, and the language is
        // dropped with it: what the server stores is ciphertext, and labelling it
        // would be a claim about bytes nobody there can read.
        const key = sealed ? await generateSealKey() : null;
        const payload = key
            ? await Promise.all(
                  files.map(async (file) => ({
                      name: file.name,
                      language: "",
                      body: await seal(file.body, key)
                  }))
              )
            : files.map((file) => ({ ...file, language: languageOf(file) }));

        if (editing) {
            const result = await updateSnippetAction(snippet.id, {
                title: title.trim() || undefined,
                description: description.trim() || null,
                files: payload
            });
            setPending(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.push("/drive/snippets");
            router.refresh();
            return;
        }

        const result = await createSnippetAction({
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            visibility,
            clientSealed: sealed,
            files: payload
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.url) {
            setLink(key ? withSealKey(result.url, key) : result.url);
            return;
        }
        router.push("/drive/snippets");
        router.refresh();
    }

    if (link) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">Your link</h2>
                        <p className="text-sm text-muted-foreground">
                            {sealed
                                ? "The key is part of this link. Polaris cannot read the snippet, and cannot get it back for you - copy it now."
                                : "Anyone with this link can read the snippet under the limits you set."}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={link} className="font-mono text-xs" />
                        <Button
                            type="button"
                            size="icon"
                            variant="secondary"
                            title="Copy the link"
                            aria-label="Copy the link"
                            onClick={async () => {
                                await navigator.clipboard.writeText(link);
                                setCopied(true);
                            }}
                        >
                            {copied ? (
                                <Check className="size-4 text-success" />
                            ) : (
                                <Copy className="size-4" />
                            )}
                        </Button>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button asChild variant="secondary">
                            <Link href="/drive/snippets">Back to snippets</Link>
                        </Button>
                    </div>
                </CardBody>
            </Card>
        );
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Title
                        <Input
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder="Named after the first file if you leave it blank"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Note (optional)
                        <Textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                            placeholder="What this is, or what to do with it"
                        />
                    </label>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3 p-0">
                    <div className="flex flex-wrap items-center gap-1 border-b border-border p-2">
                        {files.map((file, index) => (
                            <div key={index} className="flex items-center">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant={index === active ? "secondary" : "ghost"}
                                    onClick={() => setActive(index)}
                                >
                                    {file.name || "Untitled"}
                                </Button>
                                {files.length > 1 ? (
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        title="Remove this file"
                                        aria-label={`Remove ${file.name}`}
                                        onClick={() => removeFile(index)}
                                    >
                                        <X className="size-3" />
                                    </Button>
                                ) : null}
                            </div>
                        ))}
                        {files.length < MAX_SNIPPET_FILES ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={addFile}
                                title="Add another file"
                            >
                                <Plus className="size-4" />
                                Add file
                            </Button>
                        ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 px-3">
                        <Input
                            value={current.name}
                            onChange={(event) => patchFile(active, { name: event.target.value })}
                            aria-label="File name"
                            className="max-w-xs font-mono text-xs"
                        />
                        <Select
                            value={current.language}
                            onValueChange={(value) => patchFile(active, { language: value })}
                            options={LANGUAGE_OPTIONS}
                            aria-label="Language"
                            className="max-w-[12rem]"
                        />
                        <span className="ml-auto text-xs text-muted-foreground">
                            {used.toLocaleString()} / {MAX_SNIPPET_TOTAL_CHARS.toLocaleString()}
                        </span>
                    </div>

                    <div className="max-h-[55vh] min-h-[16rem] overflow-hidden">
                        <CodeSurface
                            code={current.body}
                            language={sealed ? null : languageOf(current) || null}
                            ariaLabel={`${current.name} contents`}
                            onChange={(value) => patchFile(active, { body: value })}
                        />
                    </div>
                </CardBody>
            </Card>

            {!editing ? (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Who can open it
                            <Select
                                value={visibility}
                                onValueChange={setVisibility}
                                options={VISIBILITY_OPTIONS}
                                aria-label="Who can open it"
                            />
                            <span className="text-xs text-muted-foreground">
                                A password, an expiry and a view cap can be set once it exists.
                            </span>
                        </label>
                        {visibility !== "private" ? (
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 size-4"
                                    checked={sealed}
                                    onChange={(event) => setSealed(event.target.checked)}
                                />
                                <span>
                                    Seal it in this browser
                                    <span className="block text-xs text-muted-foreground">
                                        The key goes in the link and never reaches the server.
                                        Polaris cannot preview, search or recover it, and a lost
                                        link is a lost snippet.
                                    </span>
                                </span>
                            </label>
                        ) : null}
                    </CardBody>
                </Card>
            ) : null}

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex justify-end gap-2">
                <Button asChild variant="secondary" type="button">
                    <Link href="/drive/snippets">Cancel</Link>
                </Button>
                <Button type="submit" disabled={pending}>
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Save className="size-4" />
                    )}
                    {editing ? "Save changes" : "Create snippet"}
                </Button>
            </div>
        </form>
    );
}
