import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WhaleGallery } from "./features/whale/WhaleGallery.js";
createRoot(document.getElementById("root")!).render(<StrictMode><WhaleGallery/></StrictMode>);
