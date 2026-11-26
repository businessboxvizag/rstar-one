/**
 * Brand tokens. Colours sampled from the supplied RSTAR TV logo (brand/rstar-tv-logo.png).
 * RSTAR is the primary identity (~80%); BusinessBOX appears only as a quiet
 * "Powered by BusinessBOX" endorsement (~20%).
 * Product name is a runtime setting (organisations.product_name); this is only the default.
 */
export const DEFAULT_PRODUCT_NAME = "RSTAR ONE";

export const brand = {
  rstarRed: "#CC323A",
  rstarRedDark: "#A8262D",
  rstarGold: "#F2A12B",
  ink: "#14213D", // navy typography
  inkMuted: "#5B6478",
  surface: "#FFFFFF",
  canvas: "#F6F7F9",
  border: "#E4E7EC",
  bboxAccent: "#2F6FDE", // BusinessBOX: used sparingly (partner signature, links in About)
} as const;

export const PARTNER_SIGNATURE = "Technology & Operations by BusinessBOX";
