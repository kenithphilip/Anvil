// Lightweight hook that returns whether the Tally bridge is configured.
//
// Reads /api/health (public, unauthenticated, tenant-agnostic) and looks
// up the integration entry by id. Each tally screen calls this once on
// mount to render a "Bridge not configured" banner and disable the push
// button accordingly. We do not call the bridge directly from the
// browser; integration absence comes from env-var presence.

import { useEffect, useState } from "react";
import { ObaraBackend } from "./api";

export interface TallyBridgeStatus {
  configured: boolean;
  /** True until the first /api/health response arrives. */
  loading: boolean;
  error: Error | null;
}

export const useTallyBridgeStatus = (): TallyBridgeStatus => {
  const [status, setStatus] = useState<TallyBridgeStatus>({
    configured: false,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(ObaraBackend?.health?.())
      .then((h: any) => {
        if (cancelled) return;
        const list = Array.isArray(h?.integrations) ? h.integrations : [];
        const tally = list.find((i: any) => i?.id === "tally");
        setStatus({
          configured: !!tally?.configured,
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setStatus({ configured: false, loading: false, error: err });
      });
    return () => { cancelled = true; };
  }, []);

  return status;
};
