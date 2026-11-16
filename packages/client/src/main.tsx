import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FusionApp } from "./app.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FusionApp />
  </StrictMode>,
);
