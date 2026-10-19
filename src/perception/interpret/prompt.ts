import type {
  ChatImagePart,
  ChatMessage,
  ChatTextPart,
  InterpretCapabilities,
  InterpretRequest,
} from './types';

export const INTERPRET_PROMPT_EXAMPLE = {
  version: 1,
  lens: 'diagram',
  tier: 't2',
  items: [
    {
      id: 'shape-1',
      kind: 'shape',
      shape: 'rectangle',
      x: 24,
      y: 24,
      width: 120,
      height: 56,
      label: 'Begin',
      sourceIds: ['s1', 's3'],
      confidence: 0.96,
      reason: 'The box and handwriting strokes form a labeled node.',
    },
    {
      id: 'connector-1',
      kind: 'connector',
      points: [[144, 52], [208, 52]],
      start: { itemId: 'shape-1' },
      end: null,
      startArrowhead: null,
      endArrowhead: 'arrow',
      label: 'Yes',
      sourceIds: ['s2', 's4'],
      confidence: 0.91,
      reason: 'The shaft and handwriting beside it form a labeled directed connector.',
    },
    {
      id: 'text-1',
      kind: 'text',
      x: 24,
      y: 96,
      text: 'Review',
      sourceIds: ['s5'],
      confidence: 0.99,
      reason: 'One handwriting stroke is a free note below the node.',
    },
  ],
  unresolved: [],
} as const;

export const buildInterpretPrompt = (
  request: InterpretRequest,
  capabilities: InterpretCapabilities,
): ChatMessage[] => {
  const system = [
    'You are Drawit Interpret, a careful assistant for a human-first drawing studio.',
    'Interpret the user\'s strokes and composition, and return actionable suggestions as vector edits in one JSON (json) suggestion plan.',
    'The coordinates use the same canvas coordinate space as the supplied stroke points and text boxes.',
    'Use only the supplied stroke IDs (s1, s2, …) and text IDs (t1, t2, …). Never invent IDs.',
    'A connector\'s shaft and arrowhead strokes belong only to that connector; each handwriting stroke belongs only to the one label or text item that reads it; never repeat any ID across items or unresolved entries.',
    'The shape value must be exactly rectangle, roundedRectangle, diamond, or ellipse.',
    'A connector startArrowhead and endArrowhead must each be exactly "arrow" or null.',
    'Stroke-item points are {x, y} objects, stroke-item bounds are {x, y, width, height}, and connector points are [x, y] pairs.',
    'Connector points are only the start point, each deliberate corner, and the arrowhead tip, so a straight connector has exactly two points; never trace hand wobble or the outline of a hand-drawn arrowhead.',
    'The children array contains shape item IDs from this same plan.',
    'Connector start and end itemIds must be shape item IDs from this plan, never IDs copied from t0Plan (such as p1) or source stroke IDs.',
    't0Plan is a draft from Drawit’s local recognizer with p1… item IDs; treat it only as a hint that you may improve or ignore.',
    'confidence, when present, is a number from 0 to 1. Every reason is at most 140 characters.',
    'Use tier "t2", lens "diagram", and keep every item traceable to sourceIds.',
    'A shape has id, kind "shape", shape, x, y, width, height, sourceIds, and optional label, children, confidence and reason.',
    'A connector has id, kind "connector", points, start, end, startArrowhead, endArrowhead, sourceIds, and optional label, confidence and reason.',
    'A stroke has id, kind "stroke", primitive, and either points or bounds as required by the primitive.',
    'A text item has id, kind "text", x, y, text, sourceIds, and optional confidence and reason.',
    'Stroke primitives are line, curve and freedraw with at least two points, or ellipse and rectangle with bounds.',
    'Labels and text are at most 200 characters. IDs are at most 32 characters.',
    'Use at most 40 items, 32 points per stroke or connector, 384 total points and 16 unresolved entries.',
    'Improve the user\'s own drawing; never generate or describe an image. Turn handwriting into typed text items, shape labels, or connector labels whose sourceIds are the handwriting strokes.',
    'Handwriting or typed text on or beside a connector that reads as its label (for example yes/no or a condition) becomes that connector\'s label: include those source IDs with the connector shaft and arrowhead strokes, and do not emit a separate text item; use text items only for notes belonging to neither a shape nor a connector.',
    'When an image is supplied, it shows each stroke and typed text with its set-of-mark label.',
    'Leave ambiguous marks in unresolved with a short reason instead of inventing geometry.',
    `Return valid JSON only. Complete compact example: ${JSON.stringify(INTERPRET_PROMPT_EXAMPLE)}`,
  ].join(' ');
  const requestText = JSON.stringify({
    lens: request.lens,
    strokes: request.strokes,
    texts: request.texts,
    t0Plan: request.t0Plan,
    intent: request.intent ?? null,
    jsonMode: capabilities.jsonMode,
  });
  const parts: (ChatTextPart | ChatImagePart)[] = [{
    type: 'text',
    text: `Scene data (return JSON only): ${requestText}`,
  }];
  if (capabilities.images && request.image) {
    parts.push({
      type: 'image_url',
      image_url: { url: request.image },
    });
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
};
