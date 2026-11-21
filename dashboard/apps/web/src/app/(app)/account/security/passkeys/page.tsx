/** Passkeys and security keys (/account/security/passkeys). */

import { SecurityPage } from "../security-page";

export const dynamic = "force-dynamic";

export default function Page() {
    return <SecurityPage part="passkeys" />;
}
