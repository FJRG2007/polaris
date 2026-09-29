/**
 * Hand the client components below the namespaces they translate with.
 *
 *     <Messages namespaces={["account"]}>
 *         <PreferencesForm />
 *     </Messages>
 *
 * A server component: it loads the namespaces in the request's language and
 * passes only those to the browser. Server components below do not need it -
 * they call `getTranslations` directly.
 */

import type { ReactNode } from "react";
import { getLocale } from "@/lib/i18n/request";
import type { Namespace } from "@/lib/i18n/types";
import { MessagesProvider } from "./i18n-provider";
import { pickMessages } from "@/lib/i18n/translate";

export async function Messages({
    namespaces,
    children
}: {
    namespaces: readonly Namespace[];
    children: ReactNode;
}) {
    const locale = await getLocale();
    return <MessagesProvider messages={pickMessages(locale, namespaces)}>{children}</MessagesProvider>;
}
