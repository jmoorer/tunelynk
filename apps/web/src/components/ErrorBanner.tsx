import { Link } from "react-router";

export function ErrorBanner({
  message,
  href,
}: {
  message: string;
  href?: string;
}) {
  return (
    <div
      role="alert"
      className="mx-auto mt-6 flex max-w-6xl items-center gap-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-5 py-3 text-rose-100"
    >
      <span className="flex-1">{message}</span>
      {href && (
        <Link to={href} className="font-semibold underline">
          Open it
        </Link>
      )}
    </div>
  );
}
