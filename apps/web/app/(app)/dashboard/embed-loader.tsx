"use client";

import dynamic from "next/dynamic";

// powerbi-client is a UMD module that references `self` at top level — it
// crashes when Node tries to evaluate it during server rendering. Loading
// the embed component dynamically with ssr: false keeps it strictly in
// the client bundle. Must live in a client component because Next 16
// disallows ssr:false from server components.
const EmbeddedReport = dynamic(() => import("./embed"), {
  ssr: false,
  loading: () => (
    <div className="h-[600px] w-full flex items-center justify-center text-sm text-[var(--color-ink-muted)]">
      Loading report…
    </div>
  ),
});

type Props = {
  reportId: string;
  embedUrl: string;
  embedToken: string;
};

export default function EmbedLoader(props: Props) {
  return <EmbeddedReport {...props} />;
}
