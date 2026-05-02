// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { Btn, Card, Chip, Steps, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Onboarding (first-run setup checklist)
// Migrates the legacy showOnboardingFlow.
//
// Reachable at #/onboarding. We DO NOT auto-show the screen anywhere
// (the auto-redirect on first-load is /connect, never /onboarding).
// The user reaches this screen via Cmd+K or after completing /connect.
// Once obara:v3_onboarded is set, we still let the user revisit the
// checklist for re-entry, but each step's done-status is auto-detected
// from real backend data so completed steps render as "complete" and
// don't nag the user.
// ============================================================

const WiredOnboarding = () => {
  const { useState: uS, useEffect: uE } = React;
  const [counts, setCounts] = uS({ data: null, loading: true });

  uE(() => {
    let cancel = false;
    Promise.allSettled([
      ObaraBackend?.customers?.list?.() || Promise.resolve([]),
      ObaraBackend?.orders?.list?.({ limit: 1 }) || Promise.resolve([]),
      ObaraBackend?.bom?.list?.() || Promise.resolve({ rows: [] }),
    ]).then((res) => {
      if (cancel) return;
      const customers = res[0].status === "fulfilled" ? (Array.isArray(res[0].value) ? res[0].value : (res[0].value?.rows || [])) : [];
      const orders = res[1].status === "fulfilled" ? (Array.isArray(res[1].value) ? res[1].value : (res[1].value?.rows || [])) : [];
      const bom = res[2].status === "fulfilled" ? (Array.isArray(res[2].value) ? res[2].value : (res[2].value?.rows || [])) : [];
      setCounts({ data: { customers: customers.length, orders: orders.length, bom: bom.length }, loading: false });
    });
    return () => { cancel = true; };
  }, []);

  const cfg = (ObaraBackend?.getConfig?.()) || {};
  const ready = !!(ObaraBackend?.isReady?.());

  const steps = [
    {
      title: "Connect to backend",
      detail: "Save Vercel deploy URL and tenant id, then sign in with magic link.",
      done: ready && !!cfg.url,
      action: () => (window.location.hash = "#/connect"),
      cta: "Configure backend",
    },
    {
      title: "Apply database migrations",
      detail: "Run all 10 SQL migrations against the Supabase project plus seed.sql once.",
      done: counts.data && counts.data.customers > 0,
      action: () => window.open("https://supabase.com/dashboard", "_blank"),
      cta: "Open Supabase",
    },
    {
      title: "Add a tenant member",
      detail: "Insert your auth.users row into tenant_members with role admin.",
      done: false,
      action: () => (window.location.hash = "#/admin"),
      cta: "Open Admin Center",
    },
    {
      title: "Process your first PO",
      detail: "Drag a PO PDF into Inbox or click 'New from PO' on Sales Orders.",
      done: counts.data && counts.data.orders > 0,
      action: () => (window.location.hash = "#/intake"),
      cta: "Open Inbox",
    },
    {
      title: "Mark complete",
      detail: "Tells the app to stop showing this screen on first paint.",
      done: localStorage.getItem("obara:v3_onboarded") === "1",
      action: () => {
        localStorage.setItem("obara:v3_onboarded", "1");
        window.notifySuccess?.("Onboarding marked complete", "You can revisit this checklist via #/onboarding any time.");
        window.location.hash = "#/home";
      },
      cta: "Mark done",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <>
      <WSTitle eyebrow="Setup" title="Welcome to Anvil v3"
               meta={`${doneCount} of ${steps.length} steps complete · ${pct}%`} />
      <div className="ws-content">
        <Card>
          <div className="body" style={{ marginBottom: 8 }}>
            Walk through these in order. The app re-checks each step's status on every visit, so partial progress is preserved.
          </div>
          <div className="hbar" style={{ height: 8, marginBottom: 16 }}>
            <span style={{ width: pct + "%", background: "var(--accent-2)" }} />
          </div>
          <Steps current={Math.min(doneCount, steps.length - 1)} items={steps.map((s) => s.title)} />
        </Card>

        {steps.map((s, i) => (
          <Card key={i} title={`${i + 1}. ${s.title}`}
                eyebrow={s.done ? "complete" : "pending"}
                right={<Btn sm kind={s.done ? "ghost" : "primary"} onClick={s.action}>
                  {s.done ? "Re-open" : s.cta}
                </Btn>}>
            <div className="body">{s.detail}</div>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <Chip k={s.done ? "good" : "warn"}>{s.done ? "done" : "todo"}</Chip>
              {s.done && Icon.check}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
};


export default WiredOnboarding;
