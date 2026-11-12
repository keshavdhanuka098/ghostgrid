import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { SplashGate } from "./components/SplashLoader";
import AppShell from "./layouts/AppShell";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Features = lazy(() => import("./pages/Features"));
const GraphGit = lazy(() => import("./pages/GraphGit"));
const GraphPage = lazy(() => import("./pages/GraphPage"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Investigation = lazy(() => import("./pages/Investigation"));
import Landing from "./pages/Landing";
const Mitigation = lazy(() => import("./pages/Mitigation"));
import NotFound from "./pages/NotFound";
const Reports = lazy(() => import("./pages/Reports"));
const Settings = lazy(() => import("./pages/Settings"));
const Simulation = lazy(() => import("./pages/Simulation"));
const Workspace = lazy(() => import("./pages/Workspace"));
import { ScenarioProvider } from "./state/ScenarioContext";
import { SettingsProvider } from "./state/SettingsContext";
import { ToastProvider } from "./state/ToastContext";
import { WhatIfProvider } from "./state/WhatIfContext";

export default function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <ScenarioProvider>
          <WhatIfProvider>
            <div className="app-root">
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/app" element={<AppShell />}>
                  <Route index element={<Navigate to="dashboard" replace />} />
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="scenarios" element={<Workspace />} />
                  <Route path="graph" element={<GraphPage />} />
                  <Route path="graph-git" element={<GraphGit />} />
                  <Route path="investigation" element={<Investigation />} />
                  <Route path="simulation" element={<Simulation />} />
                  <Route path="features" element={<Features />} />
                  <Route path="mitigation" element={<Mitigation />} />
                  <Route path="reports" element={<Reports />} />
                  <Route path="integrations" element={<Integrations />} />
                  <Route path="settings" element={<Settings />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </div>
            <SplashGate />
          </WhatIfProvider>
        </ScenarioProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
