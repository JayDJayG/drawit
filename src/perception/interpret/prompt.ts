import type {
  ChatImagePart,
  ChatMessage,
  ChatTextPart,
  InterpretCapabilities,
  InterpretRequest,
} from './types';

export const buildInterpretPrompt = (
  request: InterpretRequest,
  capabilities: InterpretCapabilities,
): ChatMessage[] => {
  const system = [
    'You are Drawit Interpret, a careful assistant for a human-first drawing studio.',
    'Interpret the user\'s strokes and composition, and return actionable suggestions as a JSON suggestion plan.',
    'Reference only the stroke and text IDs given in the request. Never invent IDs.',
    'Never produce or describe images to generate; return edits and diagram suggestions only.',
    'The response must be valid JSON (json) matching version 1 of the suggestion-plan schema.',
    'Use tier "t2", preserve sourceIds, and leave ambiguous marks in unresolved.',
    'Compact example: {"version":1,"lens":"diagram","tier":"t2","items":[],"unresolved":[]}',
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
