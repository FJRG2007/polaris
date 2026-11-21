/**
 * The Privacy Checkup (/account/privacy/checkup, ledger row 12): one step per
 * group of privacy settings, then the account's security, each with a
 * recommendation one press away. The same settings and the same save as the
 * privacy page - this is a walk through them, not a second copy.
 */

import { requireUser } from "@/lib/session";
import { CheckupView } from "./checkup-view";
import { privacyFor, privacyLocks } from "@/lib/privacy-service";

export const dynamic = "force-dynamic";

export default async function PrivacyCheckupPage() {
    const session = await requireUser();
    const [settings, locks] = await Promise.all([privacyFor(session.id), privacyLocks()]);
    return <CheckupView settings={settings} locked={[...locks]} />;
}
