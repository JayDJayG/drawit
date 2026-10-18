declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = import.meta.env.BASE_URL;

  const NativeFontFace = window.FontFace;
  window.FontFace = class LocalFontFace extends NativeFontFace {
    constructor(
      family: string,
      source: string | BufferSource,
      descriptors?: FontFaceDescriptors,
    ) {
      super(
        family,
        typeof source === 'string'
          ? source.replace(
              /,\s*url\(\s*https:\/\/esm\.sh\/[^)]*\)\s*(?:format\([^)]*\))?/g,
              '',
            )
          : source,
        descriptors,
      );
    }
  };
}
