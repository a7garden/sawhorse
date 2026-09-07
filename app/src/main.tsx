import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { UpgradeGate } from "@/features/upgrade/UpgradeGate";
import { useTheme } from "@/lib/theme";
import "./index.css";

useTheme.getState().init();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpgradeGate><App /></UpgradeGate>
  </React.StrictMode>,
);
