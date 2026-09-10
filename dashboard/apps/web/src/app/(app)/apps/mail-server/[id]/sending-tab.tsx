"use client";

/**
 * How mail leaves the server: straight to each recipient's server, or through
 * a relay. Most home connections cannot send on port 25 and receivers distrust
 * residential addresses, so a relay is what makes delivery work from one. The
 * relay's provider is added to each domain's SPF in the DNS plan.
 */

import Link from "next/link";
import { useState } from "react";
import { relayAction, setRelayAction } from "../actions";
import { Field, PanelError, usePanelData } from "../ui-bits";
import { Button, Input, Select, Skeleton } from "@polaris/ui";
import { mailRelaySchema, RELAY_PROVIDERS, relayProvider } from "@polaris/core";

const DIRECT = "direct";

export function SendingTab({ serverId }: { serverId: string }) {
    const panel = usePanelData(`relay:${serverId}`, () => relayAction(serverId));
    if (panel.error && !panel.data) return <PanelError message={panel.error} onRetry={() => void panel.reload()} />;
    if (!panel.data) return <Skeleton className="h-40 w-full" />;
    return <RelayForm key={JSON.stringify(panel.data.relay)} serverId={serverId} current={panel.data.relay} onSaved={() => void panel.reload()} />;
}

function RelayForm({
    serverId,
    current,
    onSaved
}: {
    serverId: string;
    current: Extract<Awaited<ReturnType<typeof relayAction>>, { relay: unknown }>["relay"];
    onSaved: () => void;
}) {
    const [provider, setProvider] = useState<string>(current?.provider ?? DIRECT);
    const [host, setHost] = useState(current?.provider === "custom" ? current.host : "");
    const [region, setRegion] = useState(current?.region ?? "");
    const [port, setPort] = useState(String(current?.port ?? 587));
    const [username, setUsername] = useState(current?.username ?? "");
    const [secret, setSecret] = useState("");
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

    const spec = provider === DIRECT ? null : relayProvider(provider);
    const input = {
        serverId,
        provider: provider === DIRECT ? null : provider,
        host,
        region,
        port: port || "587",
        username,
        secret
    };
    const parsed = mailRelaySchema.safeParse(input);
    const issue = (path: string, typed: string): string | null =>
        parsed.success || !typed.trim() ? null : (parsed.error.issues.find((entry) => entry.path[0] === path)?.message ?? null);
    const needsSecret = spec !== null && !secret && !(current && current.provider === provider && current.hasSecret);
    const unchanged =
        (provider === DIRECT && current === null) ||
        (current !== null &&
            provider === current.provider &&
            port === String(current.port) &&
            username === current.username &&
            region === current.region &&
            (provider !== "custom" || host === current.host) &&
            !secret);

    async function save(): Promise<void> {
        if (!parsed.success || pending || needsSecret) return;
        setPending(true);
        setMessage(null);
        const answer = await setRelayAction(parsed.data);
        setPending(false);
        if (answer.error) {
            setMessage({ tone: "error", text: answer.error });
            return;
        }
        setSecret("");
        setMessage({ tone: "ok", text: provider === DIRECT ? "Mail now goes straight to each recipient." : "Mail now goes out through the relay." });
        onSaved();
    }

    return (
        <form
            className="flex max-w-xl flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <Field label="Send through" hint={spec?.spfInclude ? `Adds ${spec.spfInclude} to each domain's SPF in the DNS plan.` : undefined}>
                {(id) => (
                    <Select
                        id={id}
                        value={provider}
                        onValueChange={(value) => {
                            setProvider(value);
                            const next = value === DIRECT ? null : relayProvider(value);
                            if (next) setPort(String(next.defaultPort));
                        }}
                        options={[
                            { value: DIRECT, label: "Directly, to each recipient's server" },
                            ...RELAY_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label }))
                        ]}
                    />
                )}
            </Field>
            {spec?.regional ? (
                <Field label="Region" required error={issue("region", region)}>
                    {(id) => <Input id={id} value={region} onChange={(event) => setRegion(event.target.value)} placeholder="eu-west-1" />}
                </Field>
            ) : null}
            {provider === "custom" ? (
                <Field label="SMTP host" required error={issue("host", host)}>
                    {(id) => <Input id={id} value={host} onChange={(event) => setHost(event.target.value)} placeholder="smtp.example.net" />}
                </Field>
            ) : null}
            {spec ? (
                <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Port" error={issue("port", port)} hint="587 for STARTTLS, 465 for TLS.">
                            {(id) => (
                                <Input id={id} inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ""))} />
                            )}
                        </Field>
                        <Field label="Username" hint={spec.username ? `Leave empty for "${spec.username}".` : undefined}>
                            {(id) => <Input id={id} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />}
                        </Field>
                    </div>
                    <Field
                        label="Password or API key"
                        required={needsSecret}
                        hint={current?.hasSecret && current.provider === provider ? "Leave empty to keep the one saved." : undefined}
                    >
                        {(id) => (
                            <Input id={id} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
                        )}
                    </Field>
                </>
            ) : null}
            {message ? <p className={message.tone === "error" ? "text-xs text-danger" : "text-xs text-success"}>{message.text}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={!parsed.success || pending || needsSecret || unchanged}>
                    {pending ? "Saving..." : "Save"}
                </Button>
                <p className="text-xs text-muted-foreground">
                    Polaris sends its own mail through this server as an email channel, under{" "}
                    <Link href="/admin/email" className="underline">
                        Management, Email
                    </Link>
                    .
                </p>
            </div>
        </form>
    );
}
