import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudyHarness } from "./features/design-study/StudyHarness.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode><StudyHarness /></StrictMode>,
);
