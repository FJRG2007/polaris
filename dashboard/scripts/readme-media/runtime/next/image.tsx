/** `next/image` as a plain image. */

import type { ImgHTMLAttributes } from "react";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    src: string | { src: string };
    fill?: boolean;
    priority?: boolean;
    unoptimized?: boolean;
};

export default function Image({ src, fill, priority, unoptimized, alt, ...rest }: Props) {
    void priority;
    void unoptimized;
    const style = fill
        ? { position: "absolute" as const, inset: 0, width: "100%", height: "100%", ...rest.style }
        : rest.style;
    return (
        <img
            alt={alt ?? ""}
            src={typeof src === "string" ? src : src.src}
            {...rest}
            style={style}
        />
    );
}
