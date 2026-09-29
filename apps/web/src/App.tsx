import { HealthStatus } from "./HealthStatus";

export function App() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-4 text-3xl font-bold">Tunelynk</h1>
      <HealthStatus />
    </main>
  );
}
