import type { MetadataRoute } from "next";

/** Lets phones "Add to Home Screen" with the RSTAR icon and open full-screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RSTAR ONE",
    short_name: "RSTAR ONE",
    description: "RSTAR ONE — organisation operating system for RSTAR TV.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#CC323A",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
