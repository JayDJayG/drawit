import type {
  InterpretRequest,
  InterpretRequestLimits,
  InterpretSceneInput,
  InterpretStroke,
} from './types';

const DEFAULT_LIMITS: Required<InterpretRequestLimits> = {
  maxStrokes: 128,
  maxPointsPerStroke: 128,
  maxTotalPoints: 4096,
  maxTextLength: 4000,
  maxImageLength: 1_500_000,
};

export const buildInterpretRequest = (
  input: InterpretSceneInput,
  limits: InterpretRequestLimits = {},
): InterpretRequest => {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const strokes = input.strokes
    .slice(0, effective.maxStrokes)
    .map((stroke) => ({
      id: stroke.id,
      points: simplifyStroke(stroke, effective.maxPointsPerStroke).points,
    }));
  const limitedStrokes = capTotalPoints(strokes, effective.maxTotalPoints);
  const texts = input.texts.map((text) => ({
    id: text.id,
    text: text.text.slice(0, effective.maxTextLength),
    x: round(text.x),
    y: round(text.y),
    width: round(Math.max(0, text.width)),
    height: round(Math.max(0, text.height)),
  }));
  const image = input.image && input.image.length <= effective.maxImageLength
    ? input.image
    : undefined;

  return {
    lens: input.lens,
    strokes: limitedStrokes,
    texts,
    t0Plan: input.t0Plan ?? null,
    ...(image ? { image } : {}),
    ...(input.intent ? { intent: input.intent.slice(0, effective.maxTextLength) } : {}),
  };
};

const simplifyStroke = (
  stroke: InterpretStroke,
  maxPoints: number,
): InterpretStroke => {
  const points = stroke.points;
  if (maxPoints <= 0) {
    return { id: stroke.id, points: [] };
  }
  if (maxPoints === 1) {
    return {
      id: stroke.id,
      points: points[0] ? [roundPoint(points[0])] : [],
    };
  }
  if (points.length <= maxPoints) {
    return {
      id: stroke.id,
      points: points.map(roundPoint),
    };
  }
  const sampled = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    const point = points[sourceIndex];
    if (point) {
      sampled.push(roundPoint(point));
    }
  }
  return { id: stroke.id, points: sampled };
};

const capTotalPoints = (
  strokes: InterpretStroke[],
  maxTotalPoints: number,
): InterpretStroke[] => {
  if (maxTotalPoints <= 0) {
    return [];
  }
  const total = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  if (total <= maxTotalPoints) {
    return strokes;
  }
  const counts = strokes.map(() => 0);
  let remaining = maxTotalPoints;
  for (let index = 0; index < strokes.length; index += 1) {
    const stroke = strokes[index];
    if (!stroke) {
      continue;
    }
    const pointsNeededForRemainingStrokes = Math.max(0, strokes.length - index - 1);
    const count = Math.min(
      2,
      stroke.points.length,
      Math.max(0, remaining - pointsNeededForRemainingStrokes),
    );
    counts[index] = count;
    remaining -= count;
  }
  while (remaining > 0) {
    let selected = -1;
    let largest = 0;
    for (let index = 0; index < strokes.length; index += 1) {
      const stroke = strokes[index];
      const count = counts[index] ?? 0;
      if (stroke && count < stroke.points.length && stroke.points.length - count > largest) {
        selected = index;
        largest = stroke.points.length - count;
      }
    }
    if (selected < 0) {
      break;
    }
    counts[selected] = (counts[selected] ?? 0) + 1;
    remaining -= 1;
  }
  return strokes
    .map((stroke, index) => simplifyStroke(stroke, counts[index] ?? 0))
    .filter((stroke) => stroke.points.length > 0);
};

const roundPoint = (point: { x: number; y: number }) => ({
  x: round(point.x),
  y: round(point.y),
});

const round = (value: number): number => {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
};
