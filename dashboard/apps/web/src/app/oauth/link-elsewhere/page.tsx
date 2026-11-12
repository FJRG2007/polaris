/**
 * Where an emailed sign-in link lands when it was opened somewhere other than
 * the browser and connection that asked for it - a forwarded message, a mail
 * scanner, the inbox on another machine. The link itself was left unspent, so
 * it still works where it belongs; from here the reader can ask for a new one.
 */

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";

export default async function LinkElsewherePage() {
    const t = await getTranslations("auth");

    return (
        <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
            <ShieldAlert className="size-10 shrink-0 text-warning" />
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("linkElsewhere.title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("linkElsewhere.body")}</p>
            </div>
            <Button asChild>
                <Link href="/oauth/login">{t("linkElsewhere.newLink")}</Link>
            </Button>
        </div>
    );
}
