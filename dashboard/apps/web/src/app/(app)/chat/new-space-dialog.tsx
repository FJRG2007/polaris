"use client";

/**
 * Starting a space.
 *
 * Two decisions and nothing else: what it is called, and whether it is the room
 * everybody is already in or one people are put into. Anything else - the
 * channels, the members, the description - is easier to answer once the space
 * exists and somebody is standing in it.
 */

import { useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Loader2 } from "lucide-react";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { createSpaceAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl
} from "@polaris/ui";

export function NewSpaceDialog({
    open,
    onOpenChange,
    onCreated
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}) {
    const t = useTranslations("chat");
    const router = useRouter();
    const { orgId, orgName } = useChat();
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState("private");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const create = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () => createSpaceAction({ name, visibility, orgId }),
            setError
        );
        setBusy(false);
        if (result?.error || !result?.id) return;
        onCreated();
        onOpenChange(false);
        setName("");
        router.refresh();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("newSpace.newSpace")}</DialogTitle>
                    <DialogDescription>
                        {t("newSpace.aSpaceHoldsChannelsIt")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <Input
                        value={name}
                        autoFocus
                        aria-label={t("newSpace.spaceName")}
                        placeholder={t("newSpace.engineering")}
                        maxLength={60}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && name.trim() && !busy) void create();
                        }}
                    />

                    <SegmentedControl
                        value={visibility}
                        onValueChange={setVisibility}
                        aria-label={t("newSpace.whoIsInIt")}
                        options={[
                            { value: "private", label: t("newSpace.inviteOnly") },
                            { value: "internal", label: t("newSpace.everybodyHere") }
                        ]}
                    />
                    <p className="text-xs text-muted-foreground">
                        {visibility === "private"
                            ? t("newSpace.onlyThePeopleYouAdd")
                            : orgId
                              ? t("newSpace.everybodyInOrg", { name: orgName ?? t("newSpace.thisOrganization") })
                              : t("newSpace.everybodySignedInToPolaris")}
                    </p>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("newSpace.cancel")}
                    </Button>
                    <Button size="sm" disabled={busy || !name.trim()} onClick={() => void create()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("newSpace.createSpace")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
