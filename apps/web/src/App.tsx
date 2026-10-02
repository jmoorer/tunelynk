import { HealthStatus } from "./HealthStatus";
import { GuestPrototype } from "./prototype/GuestPrototype";

export function App() {
  // PROTOTYPE (issue #10 UI spike): dev builds show the variant prototype.
  if (import.meta.env.DEV) return <GuestPrototype />;
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-4 text-3xl font-bold">Tunelynk</h1>
      <HealthStatus />
    </main>
  );
}
