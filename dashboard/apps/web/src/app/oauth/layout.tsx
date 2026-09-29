/**
 * The sign-in screens' words. These pages sit outside the app frame, so nothing
 * above them hands over more than `common`; provided here once, above the error
 * boundary as well as every page, in the language the browser asked for (or the
 * account's, on the screens reached with a session).
 */

import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

export default function OauthLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["auth", "validation"]}>{children}</Messages>;
}
