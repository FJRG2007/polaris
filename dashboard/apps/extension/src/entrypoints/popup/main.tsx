import "./style.css";
import { App } from "./app";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
