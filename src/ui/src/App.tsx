import type { ReactElement } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./AppShell.js";
import { CommitDiffPage } from "./pages/CommitDiff.js";
import { HistoryPage } from "./pages/History.js";
import { SessionDetailPage } from "./pages/SessionDetail.js";

export const App = (): ReactElement => (
  <AppShell>
    <Routes>
      <Route path="/" element={<HistoryPage />} />
      <Route path="/sessions/:id" element={<SessionDetailPage />} />
      <Route
        path="/sessions/:sessionId/commits/:sha/diff"
        element={<CommitDiffPage />}
      />
      <Route path="*" element={<HistoryPage />} />
    </Routes>
  </AppShell>
);
