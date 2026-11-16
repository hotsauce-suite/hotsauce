import type { EnvelopePageRecord } from "../schemas/envelope.ts";

export type NormalizedFieldRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type PdfFieldRect = {
  heightPt: number;
  widthPt: number;
  xPt: number;
  yPt: number;
};

export type FieldResizeHandle =
  | "bottom-left"
  | "bottom-right"
  | "top-left"
  | "top-right";

type RelativeFieldRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export function clampNormalizedFieldRect(
  rect: NormalizedFieldRect,
): NormalizedFieldRect {
  return clampFieldRect(rect);
}

export function placeFieldAtViewportPoint(input: {
  clientX: number;
  clientY: number;
  fieldHeight: number;
  fieldWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}): NormalizedFieldRect {
  const centeredRect = {
    height: input.fieldHeight,
    width: input.fieldWidth,
    x: input.clientX / input.viewportWidth - input.fieldWidth / 2,
    y: input.clientY / input.viewportHeight - input.fieldHeight / 2,
  };

  return clampNormalizedFieldRect(centeredRect);
}

export function normalizedRectToPdfRect(
  rect: NormalizedFieldRect,
  page: Pick<EnvelopePageRecord, "heightPt" | "widthPt">,
): PdfFieldRect {
  const normalizedRect = clampNormalizedFieldRect(rect);
  const widthPt = normalizedRect.width * page.widthPt;
  const heightPt = normalizedRect.height * page.heightPt;

  return {
    heightPt,
    widthPt,
    xPt: normalizedRect.x * page.widthPt,
    yPt:
      page.heightPt -
      (normalizedRect.y + normalizedRect.height) * page.heightPt,
  };
}

export function moveFieldRect(input: {
  deltaX: number;
  deltaY: number;
  maxCoordinate?: number;
  rect: RelativeFieldRect;
}): RelativeFieldRect {
  const { deltaX, deltaY, maxCoordinate = 1, rect } = input;

  return clampFieldRect(
    {
      ...rect,
      x: rect.x + deltaX,
      y: rect.y + deltaY,
    },
    maxCoordinate,
  );
}

export function resizeFieldRectFromHandle(input: {
  corner: FieldResizeHandle;
  deltaX: number;
  deltaY: number;
  maxCoordinate?: number;
  minHeight: number;
  minWidth: number;
  rect: RelativeFieldRect;
}): RelativeFieldRect {
  const {
    corner,
    deltaX,
    deltaY,
    maxCoordinate = 1,
    minHeight,
    minWidth,
    rect,
  } = input;
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  switch (corner) {
    case "top-left":
      return clampFieldRect(
        {
          height: bottom - clamp(top + deltaY, 0, bottom - minHeight),
          width: right - clamp(left + deltaX, 0, right - minWidth),
          x: clamp(left + deltaX, 0, right - minWidth),
          y: clamp(top + deltaY, 0, bottom - minHeight),
        },
        maxCoordinate,
      );
    case "top-right": {
      const nextTop = clamp(top + deltaY, 0, bottom - minHeight);
      const nextRight = clamp(right + deltaX, left + minWidth, maxCoordinate);

      return clampFieldRect(
        {
          height: bottom - nextTop,
          width: nextRight - left,
          x: left,
          y: nextTop,
        },
        maxCoordinate,
      );
    }
    case "bottom-left": {
      const nextLeft = clamp(left + deltaX, 0, right - minWidth);
      const nextBottom = clamp(bottom + deltaY, top + minHeight, maxCoordinate);

      return clampFieldRect(
        {
          height: nextBottom - top,
          width: right - nextLeft,
          x: nextLeft,
          y: top,
        },
        maxCoordinate,
      );
    }
    case "bottom-right":
      return clampFieldRect(
        {
          height: clamp(bottom + deltaY, top + minHeight, maxCoordinate) - top,
          width: clamp(right + deltaX, left + minWidth, maxCoordinate) - left,
          x: left,
          y: top,
        },
        maxCoordinate,
      );
  }
}

function clampFieldRect(
  rect: RelativeFieldRect,
  maxCoordinate = 1,
): RelativeFieldRect {
  const width = clamp(rect.width, 0.000001, maxCoordinate);
  const height = clamp(rect.height, 0.000001, maxCoordinate);

  return {
    height,
    width,
    x: clamp(rect.x, 0, maxCoordinate - width),
    y: clamp(rect.y, 0, maxCoordinate - height),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
