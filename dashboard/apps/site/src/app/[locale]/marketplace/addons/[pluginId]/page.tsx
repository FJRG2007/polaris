/*
 * The address device plugins' pages had before the rename, still linked from
 * elsewhere. Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
export { default, generateMetadata, generateStaticParams } from "../../plugins/[pluginId]/page";

export const dynamicParams = false;
