/**
 * Everything under /automations: the list, the editor, runs and secrets.
 */

import type { ReactNode } from "react";
import { requirePermission } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function AutomationsLayout({ children }: { children: ReactNode }) {
    await requirePermission("automations.use");
    return <Messages namespaces={["automations"]}>{children}</Messages>;
}
