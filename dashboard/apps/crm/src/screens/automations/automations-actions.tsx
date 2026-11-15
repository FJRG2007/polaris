"use client";

/**
 * The CRM's New button on the automations list narrowed to it: an automation
 * that starts when a record of that kind is created, opened in the central
 * editor. With no kind chosen it asks which kind first.
 */

import { useState } from "react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    useToast
} from "@polaris/ui";
import { useCrmT } from "../i18n";
import { messageOf, unwrap } from "../call";
import type { CrmObject } from "../../model/objects";
import { startCrmAutomationAction } from "../../actions/workflows";
import type { AutomationsSlotProps } from "../../lib/automation-filter";

export function CrmAutomationsActions({ object, objects }: AutomationsSlotProps) {
    const t = useCrmT();
    const toast = useToast();
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const start = async (kind: CrmObject) => {
        setBusy(true);
        try {
            const { automationId } = await unwrap(
                () => startCrmAutomationAction({ object: kind }),
                t("errors.generic")
            );
            router.push(`/automations/${automationId}`);
        } catch (caught) {
            toast.show({ title: t("automations.startFailed"), body: messageOf(caught) });
            setBusy(false);
        }
    };

    if (object)
        return (
            <Button size="sm" disabled={busy} onClick={() => void start(object)}>
                <Plus aria-hidden="true" />
                {t("automations.new")}
            </Button>
        );
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={busy}>
                    <Plus aria-hidden="true" />
                    {t("automations.new")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {objects.map((kind) => (
                    <DropdownMenuItem key={kind} onSelect={() => void start(kind)}>
                        {t(`objects.${kind}.plural`)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
