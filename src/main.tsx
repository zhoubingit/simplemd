import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

function dismissStartupScreen() {
  const startupScreen = document.getElementById("startup-screen");
  if (!startupScreen) {
    return;
  }

  startupScreen.dataset.ready = "true";
  window.setTimeout(() => startupScreen.remove(), 260);
}

requestAnimationFrame(() => {
  requestAnimationFrame(dismissStartupScreen);
});
