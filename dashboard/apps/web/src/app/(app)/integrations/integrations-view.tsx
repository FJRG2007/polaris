"use client";

/**
 * The integrations marketplace: a grid of provider cards. Available providers can
 * be configured in a dialog; the rest are shown as upcoming. VirusTotal is the
 * first live integration - it scans drop-point uploads for malware. Secrets are
 * write-only here: the form shows whether a key is set, never the key itself.
 */

import { useState, useTransition } from "react";
import { Check, ScanLine, ShieldAlert } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import type { IntegrationState } from "@/lib/integration-service";
import { saveVirusTotalAction } from "./actions";

export function IntegrationsView({ virustotal }: { virustotal: IntegrationState }) {
    const [vt, setVt] = useState(virustotal);
    const [configuring, setConfiguring] = useState(false);

    return (
        <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <IntegrationCard
                    name="VirusTotal"
                    category="Security"
                    description="Scan files uploaded to your drop points for malware and get alerted on detections."
                    icon={<ShieldAlert className="size-6 text-primary" />}
                    enabled={vt.enabled}
                    onConfigure={() => setConfiguring(true)}
                />
                <ComingSoonCard />
            </div>

            <VirusTotalDialog
                state={vt}
                open={configuring}
                onOpenChange={setConfiguring}
                onSaved={(next) => setVt(next)}
            />
        </>
    );
}

/** One marketplace tile for an available provider. */
function IntegrationCard({
    name,
    category,
    description,
    icon,
    enabled,
    onConfigure
}: {
    name: string;
    category: string;
    description: string;
    icon: React.ReactNode;
    enabled: boolean;
    onConfigure: () => void;
}) {
    return (
        <Card className="flex flex-col">
            <CardBody className="flex flex-1 flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="grid size-11 place-items-center rounded-lg bg-primary/10">{icon}</div>
                    {enabled ? (
                        <Badge variant="success" className="gap-1">
                            <Check className="size-3" />
                            Enabled
                        </Badge>
                    ) : (
                        <Badge variant="neutral">{category}</Badge>
                    )}
                </div>
                <div className="flex-1">
                    <p className="text-sm font-medium">{name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={onConfigure}>
                    {enabled ? "Manage" : "Configure"}
                </Button>
            </CardBody>
        </Card>
    );
}

/** A muted placeholder tile signalling the marketplace will grow. */
function ComingSoonCard() {
    return (
        <Card className="flex flex-col border-dashed">
            <CardBody className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
                <ScanLine className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium text-muted-foreground">More integrations coming soon</p>
                <p className="text-xs text-muted-foreground">Notifications, webhooks, and more.</p>
            </CardBody>
        </Card>
    );
}

/** Configuration dialog for the VirusTotal integration. */
function VirusTotalDialog({
    state,
    open,
    onOpenChange,
    onSaved
}: {
    state: IntegrationState;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (next: IntegrationState) => void;
}) {
    const [enabled, setEnabled] = useState(state.enabled);
    const [scanDropPoints, setScanDropPoints] = useState(state.config.scanDropPoints !== false);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Re-sync local form state whenever the dialog is (re)opened for the provider.
    function handleOpenChange(next: boolean) {
        if (next) {
            setEnabled(state.enabled);
            setScanDropPoints(state.config.scanDropPoints !== false);
            setApiKey("");
            setError(null);
        }
        onOpenChange(next);
    }

    function submit(event: React.FormEvent) {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
            const result = await saveVirusTotalAction({ enabled, apiKey, scanDropPoints });
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved({
                ...state,
                enabled,
                config: { ...state.config, scanDropPoints },
                hasCredential: state.hasCredential || apiKey.trim().length > 0
            });
            onOpenChange(false);
        });
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>VirusTotal</DialogTitle>
                    <DialogDescription>
                        Files uploaded to your drop points are sent to VirusTotal and scanned by dozens of antivirus
                        engines. You are alerted when a file is flagged. Uses the public API (files up to 32 MB).
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        API key
                        <Input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={state.hasCredential ? "Key saved - enter a new one to replace it" : "Your VirusTotal API key"}
                        />
                        <span className="text-xs text-muted-foreground">
                            Get a free key from your VirusTotal account under API key.
                        </span>
                    </label>

                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                        Enable VirusTotal
                    </label>

                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={scanDropPoints}
                            onChange={(event) => setScanDropPoints(event.target.checked)}
                        />
                        Scan drop-point uploads automatically
                    </label>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
