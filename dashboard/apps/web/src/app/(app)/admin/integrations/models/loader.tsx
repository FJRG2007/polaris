"use client";

import { AfterPaint } from "@/components/after-paint";
import type { ComponentProps, ReactNode } from "react";
import { paintRead } from "@/app/(app)/admin/paint-read";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";

type KeysProps = ComponentProps<typeof ModelKeysView>;

/**
 * The model keys and the agent accounts, both tables from one read. Not kept in
 * the tab: these are the deployment's credentials.
 */
export function ModelProvidersLoader({
    keyProviders,
    signinProviders,
    actions,
    keysCopy,
    accountsCopy,
    sharedFooter,
    privateFooter,
    revision
}: {
    keyProviders: KeysProps["providers"];
    signinProviders: KeysProps["providers"];
    actions: KeysProps["actions"];
    keysCopy: KeysProps["copy"];
    accountsCopy: KeysProps["copy"];
    /** The sharing note under the keys, as it reads when members share them and when not. */
    sharedFooter: ReactNode;
    privateFooter: ReactNode;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin.integrations.models"
            load={() => paintRead("integrations.models")}
            persist={false}
            revision={revision}
            skeleton={
                <>
                    <CardSkeleton lines={4} />
                    <CardSkeleton lines={2} />
                </>
            }
        >
            {(data) => (
                <>
                    <ModelKeysView
                        providers={keyProviders}
                        keys={data.keys}
                        actions={actions}
                        copy={keysCopy}
                        footer={data.shared ? sharedFooter : privateFooter}
                    />
                    <ModelKeysView
                        providers={signinProviders}
                        keys={data.signins}
                        actions={actions}
                        copy={accountsCopy}
                    />
                </>
            )}
        </AfterPaint>
    );
}
