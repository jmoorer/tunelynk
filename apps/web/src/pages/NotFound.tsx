import { Link } from "react-router";
import { Shell } from "../components/Shell";

export function NotFound() {
  return (
    <Shell>
      <section className="py-24 text-center">
        <p className="text-2xl font-bold">Page not found.</p>
        <Link to="/" className="mt-3 inline-block text-white/60 underline">
          Go home
        </Link>
      </section>
    </Shell>
  );
}
