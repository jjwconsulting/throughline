"use client";

import { models } from "powerbi-client";
import { PowerBIEmbed } from "powerbi-client-react";

type Props = {
  reportId: string;
  embedUrl: string;
  embedToken: string;
};

export default function EmbeddedReport({
  reportId,
  embedUrl,
  embedToken,
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
      cssClassName="h-[600px] w-full"
    />
  );
}
