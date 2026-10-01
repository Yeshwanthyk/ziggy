import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Missing #root mount point");

const render = (node: ReactNode): void => createRoot(root).render(<StrictMode>{node}</StrictMode>);

// The component gallery exists only on the dev server; production builds drop this branch.
if (import.meta.env.DEV && location.pathname.startsWith("/gallery")) {
  void import("./gallery/gallery").then(({ galleryRoute }) => render(galleryRoute()));
} else {
  render(<App />);
}
