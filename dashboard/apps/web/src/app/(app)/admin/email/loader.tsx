"use client";

import { paintRead } from "../paint-read";
import { AccountMailView } from "./email-admin";
import { SmsSenderCard } from "./sms-sender-card";
import { EmailSendersView } from "./senders-view";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

/** The senders and the account mail channel. Not kept in the tab: mail delivery setup. */
export function EmailAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.email"
            load={() => paintRead("email")}
            persist={false}
            revision={revision}
            skeleton={
                <>
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={2} />
                </>
            }
        >
            {(data) => (
                <>
                    <EmailSendersView initialSenders={data.senders} canManage={data.canManage} />
                    <SmsSenderCard senders={data.smsSenders} canManage={data.canManage} />
                    {data.accountMail ? (
                        <AccountMailView
                            channels={data.accountMail.channels}
                            selectedId={data.accountMail.selectedId}
                        />
                    ) : null}
                </>
            )}
        </AfterPaint>
    );
}
