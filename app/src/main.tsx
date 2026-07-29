import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppAlertDialog } from "./components/AppAlertDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/index.css";

if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => {
    // Custom context-menu handlers run on their target before this document-level guard.
    event.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <AppAlertDialog />
  </StrictMode>,
);
