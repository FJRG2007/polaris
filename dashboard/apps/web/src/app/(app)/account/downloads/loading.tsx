"use client";

/**
 * Downloads while the host answers for the page: its heading and, inside the
 * phone app, the app's own version and updates - none of which wait on the host, so
 * the restart into a downloaded update is there at once (offline too). Only the
 * cards, which list what the host's releases hold, are sketched.
 */

import { cn, settingType, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ThisDeviceApp } from "@/components/this-app/this-device-app";

export default function Loading() {
    const t = useTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-[17px] font-semibold tracking-tight">{t("downloads.page.title")}</h1>
                <p className={cn(settingType.body, "text-muted-foreground")}>{t("downloads.page.intro")}</p>
            </div>
            <ThisDeviceApp desktop={false} />
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true">
                <Skeleton className="h-64 w-full lg:col-span-2" />
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        </div>
    );
}
