import type { ReactElement } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./AppShell.js";
import { AutopilotProvider } from "./autopilot/AutopilotProvider.js";
import { CommitDiffPage } from "./pages/CommitDiff.js";
import { HistoryPage } from "./pages/History.js";
import { QueuePage } from "./pages/Queue.js";
import { SessionDetailPage } from "./pages/SessionDetail.js";
import { TicketDetailPage } from "./pages/TicketDetail.js";

export const App = (): ReactElement => (
  <AutopilotProvider>
    <AppShell>
      <Routes>
        <Route path="/" element={<HistoryPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route
          path="/sessions/:sessionId/commits/:sha/diff"
          element={<CommitDiffPage />}
        />
        <Route path="*" element={<HistoryPage />} />
      </Routes>
    </AppShell>
  </AutopilotProvider>
);
