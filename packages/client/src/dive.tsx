import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WhaleDive } from "./features/whale/dive/WhaleDive.js";
createRoot(document.getElementById("root")!).render(<StrictMode><WhaleDive/></StrictMode>);
