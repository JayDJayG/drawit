import type {
  NodeRef,
  SuggestionItem,
  SuggestionPlan,
} from '../../core/suggestions';
import { buildInterpretRequest } from './request-builder';
import type {
  InterpretRequest,
  InterpretRequestLimits,
  InterpretSceneInput,
} from './types';

export type InterpretAliases = {
  sourceToAlias: ReadonlyMap<string, string>;
  aliasToSource: ReadonlyMap<string, string>;
  itemToAlias: ReadonlyMap<string, string>;
  aliasToItem: ReadonlyMap<string, string>;
};

export type AliasedInterpretRequest = {
  request: InterpretRequest;
  aliases: InterpretAliases;
};

export const aliasInterpretRequest = (
  request: InterpretRequest,
): AliasedInterpretRequest => {
  const sourceToAlias = new Map<string, string>();
  const aliasToSource = new Map<string, string>();
  request.strokes.forEach((stroke, index) => {
    addAlias(sourceToAlias, aliasToSource, stroke.id, `s${index + 1}`);
  });
  request.texts.forEach((text, index) => {
    addAlias(sourceToAlias, aliasToSource, text.id, `t${index + 1}`);
  });

  const itemToAlias = new Map<string, string>();
  const aliasToItem = new Map<string, string>();
  request.t0Plan?.items.forEach((item, index) => {
    addAlias(itemToAlias, aliasToItem, item.id, `p${index + 1}`);
  });

  const aliases: InterpretAliases = {
    sourceToAlias,
    aliasToSource,
    itemToAlias,
    aliasToItem,
  };
  const t0Plan = request.t0Plan
    ? aliasPlan(request.t0Plan, aliases)
    : null;

  return {
    aliases,
    request: {
      ...request,
      strokes: request.strokes.map((stroke) => ({
        ...stroke,
        id: mapSourceId(stroke.id, aliases),
      })),
      texts: request.texts.map((text) => ({
        ...text,
        id: mapSourceId(text.id, aliases),
      })),
      t0Plan,
    },
  };
};

export const aliasInterpretSceneInput = (
  input: InterpretSceneInput,
  limits?: InterpretRequestLimits,
): AliasedInterpretRequest => {
  return aliasInterpretRequest(buildInterpretRequest(input, limits));
};

export const unaliasInterpretPlan = (
  plan: SuggestionPlan,
  aliases: InterpretAliases,
): SuggestionPlan => {
  return {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      sourceIds: item.sourceIds.map((sourceId) => (
        aliases.aliasToSource.get(sourceId) ?? sourceId
      )),
    })) as SuggestionItem[],
    unresolved: plan.unresolved.map((entry) => ({
      ...entry,
      sourceIds: entry.sourceIds.map((sourceId) => (
        aliases.aliasToSource.get(sourceId) ?? sourceId
      )),
    })),
  };
};

const aliasPlan = (
  plan: SuggestionPlan,
  aliases: InterpretAliases,
): SuggestionPlan | null => {
  let failed = false;
  const mapPlanSource = (sourceId: string): string => {
    const alias = aliases.sourceToAlias.get(sourceId);
    if (!alias) {
      failed = true;
      return '';
    }
    return alias;
  };
  const items = plan.items.map((item) => {
    const base = {
      ...item,
      id: aliases.itemToAlias.get(item.id) ?? item.id,
      sourceIds: item.sourceIds.map(mapPlanSource),
    };
    if (item.kind === 'connector') {
      return {
        ...base,
        start: aliasNodeRef(item.start, aliases),
        end: aliasNodeRef(item.end, aliases),
      };
    }
    if (item.kind === 'shape' && item.children) {
      return {
        ...base,
        children: item.children
          .map((child) => {
            const alias = aliases.itemToAlias.get(child);
            if (!alias) {
              failed = true;
            }
            return alias ?? '';
          }),
      };
    }
    return base;
  }) as SuggestionItem[];
  const unresolved = plan.unresolved.map((entry) => ({
    ...entry,
    sourceIds: entry.sourceIds.map(mapPlanSource),
  }));
  return failed
    ? null
    : {
        ...plan,
        items,
        unresolved,
      };
};

const aliasNodeRef = (
  ref: NodeRef | null,
  aliases: InterpretAliases,
): { itemId: string } | null => {
  if (!ref || !('itemId' in ref)) {
    return null;
  }
  const itemId = aliases.itemToAlias.get(ref.itemId);
  return itemId ? { itemId } : null;
};

const addAlias = (
  sourceToAlias: Map<string, string>,
  aliasToSource: Map<string, string>,
  sourceId: string,
  alias: string,
) => {
  sourceToAlias.set(sourceId, alias);
  aliasToSource.set(alias, sourceId);
};

const mapSourceId = (
  sourceId: string,
  aliases: InterpretAliases,
): string => {
  const alias = aliases.sourceToAlias.get(sourceId);
  if (!alias) {
    throw new Error(`Cannot alias unknown source ID "${sourceId}".`);
  }
  return alias;
};
