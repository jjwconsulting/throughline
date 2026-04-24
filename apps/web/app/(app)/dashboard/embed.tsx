"use client";

import { models } from "powerbi-client";
import { PowerBIEmbed } from "powerbi-client-react";

type Props = {
  reportId: string;
  embedUrl: string;
  embedToken: string;
  // Tailwind class for the embed iframe wrapper. Defaults to fill the
  // viewport height under the nav/header — appropriate for the dedicated
  // /reports/[id] page.
  cssClassName?: string;
};

export default function EmbeddedReport({
  reportId,
  embedUrl,
  embedToken,
  cssClassName = "h-[calc(100vh-180px)] w-full min-h-[600px]",
}: Props) {
  return (
    <PowerBIEmbed
      embedConfig={{
        type: "report",
        id: reportId,
        embedUrl,
        accessToken: embedToken,
        tokenType: models.TokenType.Embed,
        settings: {
          panes: {
            filters: { visible: false },
            pageNavigation: { visible: false },
          },
          background: models.BackgroundType.Transparent,
        },
      }}
      cssClassName={cssClassName}
    />
  );
}
