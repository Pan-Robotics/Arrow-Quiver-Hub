import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { hubCandidateAddresses, tailnetIdentity } from "../hubAddress";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  /**
   * How a drone can reach this Hub, best first (tailnet before LAN), for the
   * companion install command and the pull-mode connection card.
   */
  hubAddresses: publicProcedure.query(() => {
    const port = process.env.PORT || "3000";
    const tailnet = tailnetIdentity(port);
    return {
      port,
      candidates: hubCandidateAddresses(port),
      tailnet: { dnsName: tailnet.dnsName, ipv4: tailnet.ipv4, serveUrl: tailnet.serveUrl, online: tailnet.online },
      hubId: process.env.HUB_ID?.trim() || null,
    };
  }),
});
