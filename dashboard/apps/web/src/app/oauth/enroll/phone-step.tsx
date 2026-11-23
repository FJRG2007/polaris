"use client";

/**
 * The enrollment step for an instance that requires a confirmed phone: the same
 * card Account > Details shows, acting on the session the guard is holding. Once
 * the number is confirmed there is nothing left to do here, so it goes on to
 * Polaris.
 */

import { useRouter } from "next/navigation";
import { PolarisMark } from "@polaris/ui";
import type { UserPhoneView } from "@polaris/auth";
import { PhoneCard, type PhoneActions } from "@/app/(app)/account/phone-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    enrollRemovePhoneAction,
    enrollSendPhoneCodeAction,
    enrollSetPhoneAction,
    enrollVerifyPhoneAction
} from "./actions";

const ENROLL_PHONE_ACTIONS: PhoneActions = {
    setPhone: enrollSetPhoneAction,
    removePhone: enrollRemovePhoneAction,
    sendCode: enrollSendPhoneCodeAction,
    verify: enrollVerifyPhoneAction
};

export function PhoneStep({ name, phone }: { name: string; phone: UserPhoneView | null }) {
    const t = useTranslations("auth");
    const router = useRouter();
    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 safe-p-6">
            <header className="flex flex-col gap-3">
                <PolarisMark />
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("enroll.phone.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("enroll.phone.intro", { name })}</p>
            </header>
            <PhoneCard
                phone={phone}
                canSend
                actions={ENROLL_PHONE_ACTIONS}
                onVerified={() => router.replace("/")}
            />
        </main>
    );
}
