import { BrowserRouter, Route, Routes } from "react-router";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { RunView } from "./pages/RunView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/playlists/:playlistId/runs/:runId"
          element={<RunView />}
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
