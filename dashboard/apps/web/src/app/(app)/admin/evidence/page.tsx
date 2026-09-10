/**
 * Evidence (/admin/evidence): the controls in force on this instance, as the
 * facts an auditor asks for, and the dated, hashed copy to hand over.
 *
 * The page only clears the admin gate; the facts are read from
 * /api/admin/evidence once the screen is on, because gathering them touches most
 * of the database and nothing else on the screen has to wait for that.
 */

import { requireAdmin } from "@/lib/session";
import { EvidenceView } from "./evidence-view";

export const dynamic = "force-dynamic";

export default async function EvidencePage() {
    await requireAdmin();
    return <EvidenceView />;
}
