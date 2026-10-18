import type { SuggestionPlan } from '../../core/suggestions';
import { validateSuggestionPlan } from '../../core/suggestions';
import type {
  InterpretProvider,
  InterpretRequest,
} from './types';

export type MockInterpretMode = 'valid' | 'invalid' | 'empty';

export class MockInterpretProvider implements InterpretProvider {
  readonly id = 'mock-interpret';
  readonly capabilities = { images: true, jsonMode: true } as const;
  private readonly mode: MockInterpretMode;

  constructor(mode: MockInterpretMode = 'valid') {
    this.mode = mode;
  }

  async interpret(
    request: InterpretRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      const error = new Error('The interpretation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    if (this.mode === 'empty') {
      return '';
    }
    if (this.mode === 'invalid') {
      return JSON.stringify({
        version: 1,
        lens: request.lens,
        tier: 't2',
        items: [{
          id: 'invented',
          kind: 'shape',
          shape: 'rectangle',
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          sourceIds: ['not-a-user-stroke'],
        }],
        unresolved: [],
      });
    }
    const plan = cloneAsT2(request.t0Plan ?? {
      version: 1,
      lens: request.lens,
      tier: 't0',
      items: [],
      unresolved: request.strokes.map((stroke) => ({
        sourceIds: [stroke.id],
        reason: 'mock provider left this stroke unchanged',
      })),
    });
    for (const item of plan.items) {
      item.reason = item.reason ?? 'deterministic mock interpretation';
      if (item.kind === 'shape' && !item.label) {
        const text = request.texts.find((candidate) => {
          const centerX = candidate.x + candidate.width / 2;
          const centerY = candidate.y + candidate.height / 2;
          return centerX >= item.x
            && centerX <= item.x + item.width
            && centerY >= item.y
            && centerY <= item.y + item.height;
        });
        if (text) {
          item.label = text.text;
          if (!item.sourceIds.includes(text.id)) {
            item.sourceIds.push(text.id);
          }
        }
      }
    }
    return plan;
  }
}

const cloneAsT2 = (plan: SuggestionPlan): SuggestionPlan => {
  const clone = JSON.parse(JSON.stringify(plan)) as SuggestionPlan;
  clone.tier = 't2';
  const validation = validateSuggestionPlan(clone);
  if (!validation.ok) {
    throw new Error(`Mock plan is invalid: ${validation.errors.join('; ')}`);
  }
  return clone;
};
