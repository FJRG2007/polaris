import { ROUNDNESS } from "../constants";
import type { ElementOrToolType } from "../types";
import type { MarkNonNullable } from "../utility-types";
import { assertNever } from "../utils";
import type { Bounds } from "./bounds";
import type {
  DiagramElement,
  DiagramTextElement,
  DiagramEmbeddableElement,
  DiagramLinearElement,
  DiagramBindableElement,
  DiagramFreeDrawElement,
  InitializedDiagramImageElement,
  DiagramImageElement,
  DiagramTextElementWithContainer,
  DiagramTextContainer,
  DiagramFrameElement,
  RoundnessType,
  DiagramFrameLikeElement,
  DiagramElementType,
  DiagramIframeElement,
  DiagramIframeLikeElement,
  DiagramMagicFrameElement,
  DiagramArrowElement,
  DiagramElbowArrowElement,
  PointBinding,
  FixedPointBinding,
  DiagramFlowchartNodeElement,
} from "./types";

export const isInitializedImageElement = (
  element: DiagramElement | null,
): element is InitializedDiagramImageElement => {
  return !!element && element.type === "image" && !!element.fileId;
};

export const isImageElement = (
  element: DiagramElement | null,
): element is DiagramImageElement => {
  return !!element && element.type === "image";
};

export const isEmbeddableElement = (
  element: DiagramElement | null | undefined,
): element is DiagramEmbeddableElement => {
  return !!element && element.type === "embeddable";
};

export const isIframeElement = (
  element: DiagramElement | null,
): element is DiagramIframeElement => {
  return !!element && element.type === "iframe";
};

export const isIframeLikeElement = (
  element: DiagramElement | null,
): element is DiagramIframeLikeElement => {
  return (
    !!element && (element.type === "iframe" || element.type === "embeddable")
  );
};

export const isTextElement = (
  element: DiagramElement | null,
): element is DiagramTextElement => {
  return element != null && element.type === "text";
};

export const isFrameElement = (
  element: DiagramElement | null,
): element is DiagramFrameElement => {
  return element != null && element.type === "frame";
};

export const isMagicFrameElement = (
  element: DiagramElement | null,
): element is DiagramMagicFrameElement => {
  return element != null && element.type === "magicframe";
};

export const isFrameLikeElement = (
  element: DiagramElement | null,
): element is DiagramFrameLikeElement => {
  return (
    element != null &&
    (element.type === "frame" || element.type === "magicframe")
  );
};

export const isFreeDrawElement = (
  element?: DiagramElement | null,
): element is DiagramFreeDrawElement => {
  return element != null && isFreeDrawElementType(element.type);
};

export const isFreeDrawElementType = (
  elementType: DiagramElementType,
): boolean => {
  return elementType === "freedraw";
};

export const isLinearElement = (
  element?: DiagramElement | null,
): element is DiagramLinearElement => {
  return element != null && isLinearElementType(element.type);
};

export const isArrowElement = (
  element?: DiagramElement | null,
): element is DiagramArrowElement => {
  return element != null && element.type === "arrow";
};

export const isElbowArrow = (
  element?: DiagramElement,
): element is DiagramElbowArrowElement => {
  return isArrowElement(element) && element.elbowed;
};

export const isLinearElementType = (
  elementType: ElementOrToolType,
): boolean => {
  return (
    elementType === "arrow" || elementType === "line" // || elementType === "freedraw"
  );
};

export const isBindingElement = (
  element?: DiagramElement | null,
  includeLocked = true,
): element is DiagramLinearElement => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    isBindingElementType(element.type)
  );
};

export const isBindingElementType = (
  elementType: ElementOrToolType,
): boolean => {
  return elementType === "arrow";
};

export const isBindableElement = (
  element: DiagramElement | null | undefined,
  includeLocked = true,
): element is DiagramBindableElement => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "ellipse" ||
      element.type === "image" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      (element.type === "text" && !element.containerId))
  );
};

export const isRectanguloidElement = (
  element?: DiagramElement | null,
): element is DiagramBindableElement => {
  return (
    element != null &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "image" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      (element.type === "text" && !element.containerId))
  );
};

// TODO: Remove this when proper distance calculation is introduced
// @see binding.ts:distanceToBindableElement()
export const isRectangularElement = (
  element?: DiagramElement | null,
): element is DiagramBindableElement => {
  return (
    element != null &&
    (element.type === "rectangle" ||
      element.type === "image" ||
      element.type === "text" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      element.type === "freedraw")
  );
};

export const isTextBindableContainer = (
  element: DiagramElement | null,
  includeLocked = true,
): element is DiagramTextContainer => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "ellipse" ||
      isArrowElement(element))
  );
};

export const isDiagramElement = (
  element: any,
): element is DiagramElement => {
  const type: DiagramElementType | undefined = element?.type;
  if (!type) {
    return false;
  }
  switch (type) {
    case "text":
    case "diamond":
    case "rectangle":
    case "iframe":
    case "embeddable":
    case "ellipse":
    case "arrow":
    case "freedraw":
    case "line":
    case "frame":
    case "magicframe":
    case "image":
    case "selection": {
      return true;
    }
    default: {
      assertNever(type, null);
      return false;
    }
  }
};

export const isFlowchartNodeElement = (
  element: DiagramElement,
): element is DiagramFlowchartNodeElement => {
  return (
    element.type === "rectangle" ||
    element.type === "ellipse" ||
    element.type === "diamond"
  );
};

export const hasBoundTextElement = (
  element: DiagramElement | null,
): element is MarkNonNullable<DiagramBindableElement, "boundElements"> => {
  return (
    isTextBindableContainer(element) &&
    !!element.boundElements?.some(({ type }) => type === "text")
  );
};

export const isBoundToContainer = (
  element: DiagramElement | null,
): element is DiagramTextElementWithContainer => {
  return (
    element !== null &&
    "containerId" in element &&
    element.containerId !== null &&
    isTextElement(element)
  );
};

export const isUsingAdaptiveRadius = (type: string) =>
  type === "rectangle" ||
  type === "embeddable" ||
  type === "iframe" ||
  type === "image";

export const isUsingProportionalRadius = (type: string) =>
  type === "line" || type === "arrow" || type === "diamond";

export const canApplyRoundnessTypeToElement = (
  roundnessType: RoundnessType,
  element: DiagramElement,
) => {
  if (
    (roundnessType === ROUNDNESS.ADAPTIVE_RADIUS ||
      // if legacy roundness, it can be applied to elements that currently
      // use adaptive radius
      roundnessType === ROUNDNESS.LEGACY) &&
    isUsingAdaptiveRadius(element.type)
  ) {
    return true;
  }
  if (
    roundnessType === ROUNDNESS.PROPORTIONAL_RADIUS &&
    isUsingProportionalRadius(element.type)
  ) {
    return true;
  }

  return false;
};

export const getDefaultRoundnessTypeForElement = (
  element: DiagramElement,
) => {
  if (isUsingProportionalRadius(element.type)) {
    return {
      type: ROUNDNESS.PROPORTIONAL_RADIUS,
    };
  }

  if (isUsingAdaptiveRadius(element.type)) {
    return {
      type: ROUNDNESS.ADAPTIVE_RADIUS,
    };
  }

  return null;
};

export const isFixedPointBinding = (
  binding: PointBinding | FixedPointBinding,
): binding is FixedPointBinding => {
  return (
    Object.hasOwn(binding, "fixedPoint") &&
    (binding as FixedPointBinding).fixedPoint != null
  );
};

// TODO: Move this to @polaris-diagram/math
export const isBounds = (box: unknown): box is Bounds =>
  Array.isArray(box) &&
  box.length === 4 &&
  typeof box[0] === "number" &&
  typeof box[1] === "number" &&
  typeof box[2] === "number" &&
  typeof box[3] === "number";
