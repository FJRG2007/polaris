/**
 * Every API key's usage at once (/account/api-keys/usage).
 *
 * The account's own keys only. The page reads nothing itself: the heading and
 * the period picker paint first, the figures load behind skeletons shaped like
 * them.
 */

import { requireUser } from "@/lib/session";
import { AccountUsageView } from "./account-usage-view";

export const dynamic = "force-dynamic";

export default async function ApiKeysUsagePage() {
    await requireUser();
    return <AccountUsageView />;
}
