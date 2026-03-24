export type ViewportPreset = "mobile" | "tablet" | "pc";

export function getViewport(preset: ViewportPreset) {
  switch (preset) {
    case "mobile":
      return { width: 390, height: 844, deviceScaleFactor: 2 };
    case "tablet":
      return { width: 768, height: 1024, deviceScaleFactor: 2 };
    case "pc":
    default:
      return { width: 1440, height: 900, deviceScaleFactor: 2 };
  }
}

