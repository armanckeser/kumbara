import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./index.css";

// The pill nav is always on screen, so "viewport" preloading fetches every route's code-split chunk
// right after the app opens — the first tap on Budget (or any tab) runs code that is already local
// instead of downloading a chunk while the screen sits frozen on the old page.
//
// scrollRestoration replays the window's scroll position on back/forward navigation (e.g. drilling into
// a category's transactions from Budget, then hitting back) — otherwise every route mount starts at the
// top, and the caller loses their place in a long list.
const router = createRouter({
  routeTree,
  // Serve correctly whether the app is hosted at the root ("/") or under a subpath (a static-host demo on
  // GitHub Pages project sites). BASE_URL is Vite's resolved `base` (see vite.config.ts) and is "/" for
  // dev and the real prod deploy, so this is a no-op there.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: "viewport",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
