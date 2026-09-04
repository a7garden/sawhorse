import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useTheme } from "@/lib/theme";
import "./index.css";

useTheme.getState().init();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
