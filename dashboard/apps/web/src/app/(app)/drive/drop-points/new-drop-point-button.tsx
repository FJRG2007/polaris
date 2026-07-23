"use client";

/**
 * Header actions for the Drop points page. "New drop point" and "Schedule drop
 * point" open the request dialog in picker mode (no fixed folder) - the latter
 * with the Schedule section expanded. "Templates" lists the user's saved config
 * templates and can start a new drop point pre-filled from one. The same dialog is
 * used from the Files browser.
 */

import { useState } from "react";
import { CalendarClock, Inbox, LayoutTemplate, Trash2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import { RequestDialog, type RequestInitial, type RequestTarget } from "../request-dialog";
import { deleteDropPointTemplateAction, listDropPointTemplatesAction } from "../request-actions";

interface TemplateRow {
    id: string;
    name: string;
    config: string;
    createdAt: string;
}

/** Guardrails a template can carry (a JSON subset of the create form). */
interface TemplateConfig {
    instructions?: string;
    allowedExtensions?: string[];
    deniedExtensions?: string[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    maxFiles?: number;
    requireLogin?: boolean;
    allowedUsers?: string[];
    allowedCidrs?: string[];
    allowedCountries?: string[];
    allowedContinents?: string[];
    allowUploaderDelete?: boolean;
    uploaderDeleteWindowSeconds?: number | null;
}

const toMb = (bytes?: number): number | undefined =>
    bytes ? Math.max(1, Math.round(bytes / (1024 * 1024))) : undefined;

/** Turn a saved template's config into a create-form prefill (no title/schedule). */
function initialFromTemplate(config: string): RequestInitial {
    let parsed: TemplateConfig = {};
    try {
        parsed = JSON.parse(config) as TemplateConfig;
    } catch {
        // Ignore a corrupt template; the form just opens with defaults.
    }
    return {
        instructions: parsed.instructions,
        extensions: (parsed.allowedExtensions ?? []).join(", "),
        deniedExtensions: (parsed.deniedExtensions ?? []).join(", "),
        maxMb: toMb(parsed.maxSizeBytes),
        minMb: toMb(parsed.minSizeBytes),
        maxFiles: parsed.maxFiles,
        requireLogin: parsed.requireLogin,
        allowedUsers: (parsed.allowedUsers ?? []).join(", "),
        allowedCidrs: (parsed.allowedCidrs ?? []).join(", "),
        geoCountries: parsed.allowedCountries ?? [],
        geoContinents: parsed.allowedContinents ?? [],
        allowUploaderDelete: parsed.allowUploaderDelete,
        deleteWindowMin: parsed.uploaderDeleteWindowSeconds
            ? Math.round(parsed.uploaderDeleteWindowSeconds / 60)
            : undefined
    };
}

export function NewDropPointButton({
    connections
}: {
    connections: { id: string; name: string }[];
}) {
    const [target, setTarget] = useState<RequestTarget | null>(null);
    const [scheduleFocus, setScheduleFocus] = useState(false);
    const [initial, setInitial] = useState<RequestInitial | undefined>(undefined);
    const [templatesOpen, setTemplatesOpen] = useState(false);
    const [templates, setTemplates] = useState<TemplateRow[] | null>(null);

    const disabled = connections.length === 0;

    function open(opts?: { schedule?: boolean; initial?: RequestInitial }) {
        setScheduleFocus(opts?.schedule ?? false);
        setInitial(opts?.initial);
        setTarget({ connectionId: "", path: "", name: "" });
    }

    async function openTemplates() {
        setTemplatesOpen(true);
        setTemplates(null);
        setTemplates(await listDropPointTemplatesAction());
    }

    async function removeTemplate(id: string) {
        await deleteDropPointTemplateAction(id);
        setTemplates((prev) => prev?.filter((row) => row.id !== id) ?? null);
    }

    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => open()} disabled={disabled}>
                    <Inbox className="size-4" />
                    New drop point
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => open({ schedule: true })}
                    disabled={disabled}
                >
                    <CalendarClock className="size-4" />
                    Schedule drop point
                </Button>
                <Button size="sm" variant="ghost" onClick={openTemplates}>
                    <LayoutTemplate className="size-4" />
                    Templates
                </Button>
            </div>

            <RequestDialog
                target={target}
                connections={connections}
                initial={initial}
                scheduleFocus={scheduleFocus}
                onOpenChange={(next) => !next && setTarget(null)}
            />

            <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Templates</DialogTitle>
                        <DialogDescription>
                            Reusable drop-point settings you have saved.
                        </DialogDescription>
                    </DialogHeader>
                    {templates === null ? (
                        <p className="p-3 text-sm text-muted-foreground">Loading...</p>
                    ) : templates.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">
                            No templates yet. Open a drop point and choose &quot;Save as
                            template&quot;.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {templates.map((template) => (
                                <li
                                    key={template.id}
                                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                                >
                                    <span className="min-w-0 truncate">{template.name}</span>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => {
                                                setTemplatesOpen(false);
                                                open({
                                                    initial: initialFromTemplate(template.config)
                                                });
                                            }}
                                        >
                                            Use
                                        </Button>
                                        <button
                                            type="button"
                                            onClick={() => removeTemplate(template.id)}
                                            className="text-muted-foreground hover:text-danger"
                                            aria-label="Delete template"
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
