import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The design's typefaces, bundled rather than fetched: a packaged desktop app
// cannot depend on Google Fonts being reachable. Both are SIL OFL 1.1, which
// permits redistribution. Weights match what the prototype requested.
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("Elemento #root não encontrado");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
