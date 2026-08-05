/**
 * Model keys moved to the account (/account/ai-keys).
 *
 * They were never a property of the Agents app: they are the provider accounts a
 * person's AI work bills to, wherever Polaris does it. The path stays because
 * people bookmark the screen they store credentials on, and a 404 there reads as
 * the keys being gone.
 */

import { redirect } from "next/navigation";

export default function ModelKeysPage() {
    redirect("/account/ai-keys");
}
