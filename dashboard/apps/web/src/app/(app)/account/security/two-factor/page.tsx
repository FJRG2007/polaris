/** Two-factor (/account/security/two-factor): the authenticator, which methods count, and Telegram. */

import { SecurityPage } from "../security-page";

export const dynamic = "force-dynamic";

export default function Page() {
    return <SecurityPage part="two-factor" />;
}
