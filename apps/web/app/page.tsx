import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-2xl">
        <p className="text-sm uppercase tracking-widest text-[var(--color-accent)] mb-4">
          Throughline &middot; working name
        </p>
        <h1 className="font-display text-5xl md:text-6xl leading-tight mb-6">
          Commercial analytics for life sciences.
        </h1>
        <p className="text-lg text-[var(--color-ink-muted)] mb-8">
          Unified field, sales, and engagement data &mdash; delivered through
          embedded Power BI, backed by Microsoft Fabric, configured in minutes.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center px-5 py-3 rounded-md bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition"
        >
          Enter demo
        </Link>
      </div>
    </main>
  );
}
