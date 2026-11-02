"use client";

/** The Overview's card for asking Polar something: the answer opens in Polar's
 *  own panel, which is where the conversation carries on. */

import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button, Input } from "@polaris/ui";
import { usePolar } from "@/components/polar/polar-panel";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function PolarWidget() {
    const t = useTranslations("home");
    const { ask } = usePolar();
    const [question, setQuestion] = useState("");
    return (
        <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (!question.trim()) return;
                ask("", question, true);
                setQuestion("");
            }}
        >
            <Input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={t("polarCard.placeholder")}
                aria-label={t("polarCard.placeholder")}
                maxLength={2000}
                className="min-w-0 flex-1"
            />
            <Button
                type="submit"
                size="icon"
                aria-label={t("polarCard.send")}
                title={t("polarCard.send")}
                disabled={!question.trim()}
            >
                <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
        </form>
    );
}
