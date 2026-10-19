import type { SuggestionPlan, SuggestionPoint } from '../../core/suggestions';

export type InterpretCapabilities = {
  images: boolean;
  jsonMode: boolean;
};

export type InterpretProvider = {
  id: string;
  capabilities: InterpretCapabilities;
  interpret(
    request: InterpretRequest,
    options: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export type InterpretUsage = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type InterpretCompletion = {
  content: string;
  finishReason: string | null;
  usage?: InterpretUsage;
  model: string;
};

export type CompleteInterpretProvider = InterpretProvider & {
  complete(
    request: InterpretRequest,
    options: { signal?: AbortSignal },
  ): Promise<InterpretCompletion>;
};

export type InterpretStroke = {
  id: string;
  points: SuggestionPoint[];
};

export type InterpretText = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InterpretRequest = {
  lens: SuggestionPlan['lens'];
  strokes: InterpretStroke[];
  texts: InterpretText[];
  t0Plan: SuggestionPlan | null;
  image?: string;
  intent?: string;
};

export type InterpretSceneInput = {
  lens: SuggestionPlan['lens'];
  strokes: InterpretStroke[];
  texts: InterpretText[];
  t0Plan?: SuggestionPlan | null;
  image?: string;
  intent?: string;
};

export type InterpretRequestLimits = {
  maxStrokes?: number;
  maxPointsPerStroke?: number;
  maxTotalPoints?: number;
  maxTexts?: number;
  maxTextLength?: number;
  maxTotalTextLength?: number;
  maxIntentLength?: number;
  maxImageLength?: number;
};

export type ChatTextPart = {
  type: 'text';
  text: string;
};

export type ChatImagePart = {
  type: 'image_url';
  image_url: { url: string };
};

export type ChatMessage = {
  role: 'system' | 'user';
  content: string | (ChatTextPart | ChatImagePart)[];
};
