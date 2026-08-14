"use client";

/**
 * Sending text to a drop point.
 *
 * The counter is live because the ceiling is a real refusal, not a suggestion:
 * finding out you were 200 characters over after pasting a config and pressing
 * send is the version of this that wastes somebody's time.
 *
 * Sealing, when the drop point allows it, encrypts here and shows the key
 * afterwards - it is the sender's to pass on, and nothing on the server ever had
 * it. That is also why it is off by default: it makes the recipient's life
 * harder, so it has to be a choice somebody made on purpose.
 */

import { useState, type FormEvent } from "react";
import { PublicShell } from "@/components/public-shell";
import { Check, Copy, Loader2, Send } from "lucide-react";
import { generateSealKey, seal } from "@/lib/browser-seal";
import { submitTextAction } from "@/app/(app)/drive/drop-points/text-request-actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Textarea } from "@polaris/ui";

export function SubmitTextForm({
    token,
    title,
    instructions,
    maxLength,
    allowSealed,
    signedIn
}: {
    token: string;
    title: string;
    instructions: string | null;
    maxLength: number;
    allowSealed: boolean;
    signedIn: boolean;
}) {
    const [name, setName] = useState("");
    const [body, setBody] = useState("");
    const [sealed, setSealed] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentKey, setSentKey] = useState<string | null>(null);
    const [sent, setSent] = useState(false);
    const [copied, setCopied] = useState(false);

    const over = body.length > maxLength;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);

        const key = sealed ? await generateSealKey() : null;
        const result = await submitTextAction(token, {
            name: name.trim() || "pasted.txt",
            body: key ? await seal(body, key) : body,
            sealed
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSent(true);
        setSentKey(key);
        setBody("");
    }

    if (sent) {
        return (
            <PublicShell signedIn={signedIn}>
                <Card>
                    <CardHeader>
                        <CardTitle>Sent</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            It reached whoever asked for it. You can close this page.
                        </p>
                        {sentKey ? (
                            <>
                                <p className="text-sm">
                                    You sealed it, so they need this key to read it. Send it to them
                                    some other way - it was never sent with the text.
                                </p>
                                <div className="flex items-center gap-2">
                                    <Input
                                        readOnly
                                        value={sentKey}
                                        className="font-mono text-xs"
                                        aria-label="The key they need"
                                    />
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="secondary"
                                        title="Copy the key"
                                        aria-label="Copy the key"
                                        onClick={async () => {
                                            await navigator.clipboard.writeText(sentKey);
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
                            </>
                        ) : null}
                        <div className="flex justify-end">
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => {
                                    setSent(false);
                                    setSentKey(null);
                                    setCopied(false);
                                }}
                            >
                                Send something else
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            </PublicShell>
        );
    }

    return (
        <PublicShell signedIn={signedIn}>
            <Card>
                <CardHeader>
                    <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {instructions ? (
                            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                                {instructions}
                            </p>
                        ) : null}
                        <label className="flex flex-col gap-1 text-sm">
                            Name it (optional)
                            <Input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="e.g. .env.production"
                                className="font-mono text-xs"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Text
                            <Textarea
                                value={body}
                                onChange={(event) => setBody(event.target.value)}
                                rows={12}
                                required
                                spellCheck={false}
                                className="font-mono text-xs"
                                placeholder="Paste it here"
                            />
                            <span
                                className={`text-xs ${over ? "text-danger" : "text-muted-foreground"}`}
                            >
                                {body.length.toLocaleString()} / {maxLength.toLocaleString()}
                                {over ? " - too long to send" : ""}
                            </span>
                        </label>
                        {allowSealed ? (
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
                                        Polaris stores it unreadable and gives you a key to pass on
                                        separately. Without the key nobody can open it.
                                    </span>
                                </span>
                            </label>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || over || body.trim() === ""}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Send className="size-4" />
                            )}
                            Send
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </PublicShell>
    );
}
