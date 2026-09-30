/**
 * One automation: its flow to read and change, and the log of what it did.
 *
 * `/places/devices/automations/new` is a new one, started from a template when
 * the address names one (`?template=autoOff&device=<id>`).
 */

import { redirect } from "next/navigation";
import { placesT } from "../../../../../lib/i18n";
import { TEMPLATES } from "../../../../../lib/automation-kinds";
import { requireHomeUser } from "../../../../../lib/access";
import { AutomationEditor } from "../../../../../screens/automations/automation-editor";

export const dynamic = "force-dynamic";

function one(value: string | string[] | undefined): string | null {
    const found = Array.isArray(value) ? value[0] : value;
    return found && found.length <= 64 ? found : null;
}

export default async function AutomationPage({
    params,
    searchParams
}: {
    params: Promise<Record<string, string | string[]>>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const t = await placesT();
    const { canManage, canControl } = await requireHomeUser("home.read");
    const { id } = await params;
    const query = await searchParams;
    const raw = one(id);
    const automationId = raw === "new" ? null : raw;
    const template = one(query.template);
    // Somebody who cannot write automations has nothing to start here.
    if (!automationId && !canManage) redirect("/places/devices/automations");

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <h1 className="sr-only">{t("pages.automations.title")}</h1>
            <AutomationEditor
                key={automationId ?? "new"}
                automationId={automationId}
                template={
                    template && (TEMPLATES as readonly string[]).includes(template)
                        ? template
                        : null
                }
                deviceId={one(query.device)}
                canManage={canManage}
                canControl={canControl}
                initialTab={one(query.tab) === "runs" ? "runs" : "flow"}
            />
        </div>
    );
}
