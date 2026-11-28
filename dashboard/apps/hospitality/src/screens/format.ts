"use client";

/** Hospitality's formatters, bound to the reader's Polaris display preferences. */

import { useMemo } from "react";
import { hostUi } from "@polaris/app-host/client";
import { formatMoney, formatRate, typedAmount } from "../model/money-format";

export function useHospitalityFormat() {
    const format = hostUi.displayFormat.useDisplayFormat();
    return useMemo(
        () => ({
            ...format,
            money: (cents: number, currency: string) => formatMoney(format, cents, currency),
            rate: (basisPoints: number) => formatRate(format, basisPoints),
            typed: (cents: number) => typedAmount(format, cents)
        }),
        [format]
    );
}
