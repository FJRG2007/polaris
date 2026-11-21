/** Recovery (/account/security/recovery): backup codes, recovery questions and the successor. */

import { SecurityPage } from "../security-page";

export const dynamic = "force-dynamic";

export default function Page() {
    return <SecurityPage part="recovery" />;
}
