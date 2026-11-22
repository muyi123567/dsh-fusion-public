import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPreview } from "./features/workbench-preview/WorkbenchPreview.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode><WorkbenchPreview /></StrictMode>,
);
