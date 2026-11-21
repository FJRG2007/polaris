/** Password and sign-in (/account/security): password, PIN, the other ways in, and what a session is allowed. */

import { SecurityPage } from "./security-page";

export const dynamic = "force-dynamic";

export default function Page() {
    return <SecurityPage part="sign-in" />;
}
