export type TextElementLike = {
  id?: string;
  type?: string;
  isDeleted?: boolean;
  originalText?: unknown;
  text?: unknown;
  customData?: Record<string, unknown>;
};

export const getElementText = (element: TextElementLike): string => {
  if (typeof element.originalText === 'string') {
    return element.originalText;
  }
  if (typeof element.text === 'string') {
    return element.text;
  }
  const customText = element.customData?.text;
  return typeof customText === 'string' ? customText : '';
};

export const consumedTextSourcesArePreserved = (
  consumedSourceIds: readonly string[],
  before: readonly TextElementLike[],
  after: readonly TextElementLike[],
): boolean => {
  return consumedSourceIds.every((sourceId) => {
    const source = before.find((element) => element.id === sourceId);
    if (!source) {
      return false;
    }
    const originalText = getElementText(source);
    const matches = after.filter((element) => {
      if (element.isDeleted || element.type !== 'text') {
        return false;
      }
      const sourceIds = element.customData?.sourceIds;
      return (Array.isArray(sourceIds) && sourceIds.includes(sourceId))
        || getElementText(element) === originalText;
    });
    return matches.length === 1;
  });
};
