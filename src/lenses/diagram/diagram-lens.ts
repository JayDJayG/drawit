import type { SuggestionPlan } from '../../core/suggestions';
import {
  recognizeDiagram,
  type T0DiagramInput,
} from '../../perception/t0';

export const suggestDiagram = (input: T0DiagramInput): SuggestionPlan => {
  return recognizeDiagram(input);
};
