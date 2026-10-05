import type { DiagramTextContainer } from "./types";

export const originalContainerCache: {
  [id: DiagramTextContainer["id"]]:
    | {
        height: DiagramTextContainer["height"];
      }
    | undefined;
} = {};

export const updateOriginalContainerCache = (
  id: DiagramTextContainer["id"],
  height: DiagramTextContainer["height"],
) => {
  const data =
    originalContainerCache[id] || (originalContainerCache[id] = { height });
  data.height = height;
  return data;
};

export const resetOriginalContainerCache = (
  id: DiagramTextContainer["id"],
) => {
  if (originalContainerCache[id]) {
    delete originalContainerCache[id];
  }
};

export const getOriginalContainerHeightFromCache = (
  id: DiagramTextContainer["id"],
) => {
  return originalContainerCache[id]?.height ?? null;
};
