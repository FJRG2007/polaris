import type { Metadata } from "next";
import { ToastProvider } from "@polaris/ui";
import { guardedUser } from "@/lib/session";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { EmbedNotice, PolarEmbed } from "./polar-embed";
import { chatScope, extensionOrigin } from "@/lib/polar/embed-bridge";
import { PolarProvider } from "@/components/polar/polar-panel";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("page.title") };
}

/**
 * Polar for the browser extension's side panel: the same chat as `/polar`,
 * with none of the app's frame around it. Outside the `(app)` group so a
 * missing session is a screen that says so rather than a redirect to a sign-in
 * page the panel is not allowed to frame. Framing is governed in
 * `next.config.mjs`: only the extension origin named in `?ext=` may.
 */
export default async function PolarEmbedPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const parent = extensionOrigin(params.ext);
    const chat = parent ? chatScope(params.chat) : null;
    const user = await guardedUser();
    const access = user ? await polarAccessFor(user.id) : null;
    return (
        <Messages namespaces={["chat", "shortcuts", "polar"]}>
            {!user ? (
                <EmbedNotice kind="signedOut" />
            ) : !access?.use ? (
                <EmbedNotice kind="noAccess" />
            ) : (
                <ToastProvider>
                    <PolarProvider allowed>
                        <PolarEmbed parent={parent} chat={chat} account={user.id} />
                    </PolarProvider>
                </ToastProvider>
            )}
        </Messages>
    );
}
