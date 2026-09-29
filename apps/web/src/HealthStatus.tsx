import type { HealthResponse } from "@tunelynk/shared";
import { useEffect, useState } from "react";
import { fetchHealth } from "./api";

type State =
  | { status: "loading" }
  | { status: "ok"; health: HealthResponse }
  | { status: "unreachable" };

export function HealthStatus() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then(
      (health) => {
        if (!cancelled) setState({ status: "ok", health });
      },
      () => {
        if (!cancelled) setState({ status: "unreachable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading")
    return <p className="text-gray-500">Checking API…</p>;
  if (state.status === "unreachable")
    return <p className="text-red-600">API unreachable</p>;
  return <p className="text-green-700">{`API: up / DB: ${state.health.db}`}</p>;
}
