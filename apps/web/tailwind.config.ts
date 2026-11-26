import type { Config } from "tailwindcss";

// Brand tokens mirror packages/shared/src/branding.ts (sampled from the supplied RSTAR TV logo).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rstar: { DEFAULT: "#CC323A", dark: "#A8262D", light: "#FBEAEB", gold: "#F2A12B" },
        ink: { DEFAULT: "#14213D", muted: "#5B6478", faint: "#8A93A6" },
        canvas: "#F6F7F9",
        line: "#E4E7EC",
        bbox: "#2F6FDE",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Noto Sans Telugu", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
