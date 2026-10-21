import "@fontsource-variable/inter";
import "katex/dist/katex.min.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
