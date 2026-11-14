"use client";

import { loadPrivacyAction } from "./data";
import { CardSkeleton } from "../region-skeletons";
import { PrivacySections } from "./privacy-sections";
import { AfterPaint } from "@/components/after-paint";
import { PublicProfilesForm } from "./public-profiles-form";
import { PeopleDiscoveryForm } from "./people-discovery-form";

/** The privacy settings, asked for after the headings have painted. */
export function PrivacyLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-privacy"
            load={loadPrivacyAction}
            revision={revision}
            skeleton={
                <PrivacySections
                    profiles={<CardSkeleton lines={2} />}
                    discovery={<CardSkeleton lines={4} />}
                />
            }
        >
            {(data) => (
                <PrivacySections
                    profiles={
                        <PublicProfilesForm
                            enabled={data.publicProfiles}
                            followerDefault={data.followerDefault}
                        />
                    }
                    discovery={<PeopleDiscoveryForm policy={data.discovery} />}
                />
            )}
        </AfterPaint>
    );
}
