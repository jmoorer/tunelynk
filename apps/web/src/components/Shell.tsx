export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-zinc-950 pb-40 text-white">
      {children}
    </main>
  );
}
