"use client";

/**
 * Ask where a server lives. Each option states how a domain reaches a server like
 * that, so the answer is made for the right reason; picking one saves immediately
 * (no separate save step) and the current value is marked.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { ServerEnvironment } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { setServerEnvironmentAction, setServerWildcardAction } from "./actions";
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "./environment-meta";

export interface EnvironmentTarget {
    /** Null for the box Polaris runs on, which has no Host row. */
    hostId: string | null;
    name: string;
    current: ServerEnvironment;
    /** Wildcard domain pointed at this server, empty when none is configured. */
    wildcardDomain: string;
    /** Polaris's own guess, surfaced while there is no answer yet. */
    suggested: ServerEnvironment;
    confirmed: boolean;
}

export function EnvironmentDialog({
    target,
    onClose
}: {
    target: EnvironmentTarget | null;
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, setPending] = useState<ServerEnvironment | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function pick(environment: ServerEnvironment) {
        if (!target) return;
        setPending(environment);
        setError(null);
        const result = await setServerEnvironmentAction({ hostId: target.hostId, environment });
        setPending(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        // A registered server also has its domain here, so the dialog stays open to
        // finish that; the local box has nothing left to answer.
        if (!target.hostId) onClose();
        router.refresh();
    }

    // Only worth showing while unanswered: once confirmed, the marked option says it all.
    const suggestion =
        target && !target.confirmed && target.suggested !== "unknown"
            ? ENVIRONMENT_META[target.suggested].label
            : null;

    return (
        <Dialog
            open={Boolean(target)}
            onOpenChange={(open) => {
                // Only the content unmounts, so a failed save would otherwise still
                // be on screen the next time the dialog opens - on any server.
                if (!open) {
                    setError(null);
                    onClose();
                }
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Where does {target?.name} live?</DialogTitle>
                    <DialogDescription>
                        This decides how a domain can be pointed at it, and whether it can serve public traffic
                        directly. Registered servers can also take a wildcard domain of their own below.
                    </DialogDescription>
                </DialogHeader>
                {suggestion ? (
                    <p className="mb-3 text-xs text-muted-foreground">
                        Polaris detected <b className="font-medium text-foreground">{suggestion}</b> from its address.
                        Confirm it or pick another.
                    </p>
                ) : null}
                <div className="flex flex-col gap-2">
                    {ENVIRONMENT_CHOICES.map((environment) => {
                        const meta = ENVIRONMENT_META[environment];
                        const selected = target?.current === environment;
                        return (
                            <button
                                key={environment}
                                type="button"
                                onClick={() => pick(environment)}
                                disabled={pending !== null}
                                className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-60 ${
                                    selected
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:border-primary/40 hover:bg-card-hover"
                                }`}
                            >
                                <span className="flex items-center gap-2 text-sm font-medium">
                                    {meta.label}
                                    {selected ? <Check className="size-3.5 text-primary" /> : null}
                                    {pending === environment ? (
                                        <span className="text-xs font-normal text-muted-foreground">Saving...</span>
                                    ) : null}
                                </span>
                                <span className="text-xs text-muted-foreground">{meta.summary}</span>
                                <span className="text-xs text-foreground/70">{meta.routing}</span>
                            </button>
                        );
                    })}
                </div>
                {target?.hostId ? <ServerWildcard hostId={target.hostId} current={target.wildcardDomain} /> : null}
                {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The wildcard domain for one server. With it, services deployed there get
 * `<service>.<domain>` from that server's own edge; without it they fall back to a
 * hostname built from the server's IP, which a server reached by name cannot have
 * at all.
 */
function ServerWildcard({ hostId, current }: { hostId: string; current: string }) {
    const router = useRouter();
    const [value, setValue] = useState(current);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setSaving(true);
        setSaved(false);
        setError(null);
        const result = await setServerWildcardAction({ hostId, wildcardDomain: value });
        setSaving(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
        router.refresh();
    }

    return (
        <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            <label className="flex flex-col gap-1 text-sm">
                Wildcard domain for this server
                <div className="flex items-center gap-2">
                    <Input
                        value={value}
                        onChange={(event) => {
                            setValue(event.target.value);
                            setSaved(false);
                        }}
                        placeholder="apps.example.com"
                        autoComplete="off"
                    />
                    <Button size="sm" variant="secondary" onClick={save} disabled={saving || value === current}>
                        {saving ? "Saving..." : "Save"}
                    </Button>
                </div>
            </label>
            <p className="text-xs text-muted-foreground">
                Point <code>*.{value.trim() || "apps.example.com"}</code> at this server, and its services get a real
                domain with a Let&apos;s Encrypt certificate. Leave empty to use free IP-based subdomains.
            </p>
            {saved ? <p className="text-xs text-success">Saved.</p> : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
