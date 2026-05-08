// Unit tests for src/api/deploys/index.js. Covers the input
// normalization on the public POST + the validation guards.
//
// Audit: SOC 2 CC8.1 change-log endpoint. We don't mount the
// route here, just exercise the buildRow + normalizeVercel
// helpers.

import { describe, it, expect } from "vitest";
import { __test as deploys } from "../api/deploys/index.js";

describe("deploys.buildRow (manual / other-provider POST)", () => {
  it("defaults to manual + production + ready when fields are absent", () => {
    const row = deploys.buildRow({});
    expect(row.provider).toBe("manual");
    expect(row.environment).toBe("production");
    expect(row.state).toBe("ready");
    expect(row.deployment_id).toBeNull();
    expect(row.commit_sha).toBeNull();
  });

  it("trims commit_message to its first line and 200 chars", () => {
    const long = "first line of the commit\n\nfollow-up paragraph that should be dropped";
    const row = deploys.buildRow({ provider: "manual", commit_message: long });
    expect(row.commit_message).toBe("first line of the commit");
  });

  it("rejects an unknown provider", () => {
    expect(() => deploys.buildRow({ provider: "magic" })).toThrow(/provider must be one of/);
  });

  it("rejects an unknown environment", () => {
    expect(() => deploys.buildRow({ environment: "staging" })).toThrow(/environment must be one of/);
  });

  it("rejects an unknown state", () => {
    expect(() => deploys.buildRow({ state: "in-progress" })).toThrow(/state must be one of/);
  });

  it("preserves a valid manual deploy row end-to-end", () => {
    const row = deploys.buildRow({
      provider: "manual",
      environment: "production",
      deployment_id: "manual-12345",
      url: "https://anvil.app",
      commit_sha: "abc123",
      commit_message: "release v2",
      branch: "main",
      state: "ready",
      meta: { actor: "ops" },
    });
    expect(row).toMatchObject({
      provider: "manual",
      environment: "production",
      deployment_id: "manual-12345",
      url: "https://anvil.app",
      commit_sha: "abc123",
      commit_message: "release v2",
      branch: "main",
      state: "ready",
      meta: { actor: "ops" },
    });
  });
});

describe("deploys.normalizeVercel (Vercel webhook payload)", () => {
  it("maps the modern Vercel deployment payload shape", () => {
    const payload = {
      type: "deployment.ready",
      target: "production",
      deployment: {
        id: "dpl_abc",
        url: "anvil-prod.vercel.app",
        meta: {
          githubCommitSha: "abc123def",
          githubCommitRef: "main",
          githubCommitMessage: "fix the thing\n\nlonger body",
        },
      },
    };
    const row = deploys.normalizeVercel(payload);
    expect(row.provider).toBe("vercel");
    expect(row.environment).toBe("production");
    expect(row.deployment_id).toBe("dpl_abc");
    expect(row.url).toBe("https://anvil-prod.vercel.app");
    expect(row.commit_sha).toBe("abc123def");
    expect(row.branch).toBe("main");
    expect(row.commit_message).toBe("fix the thing");
    expect(row.state).toBe("ready");
  });

  it("flips state to error when the Vercel type is a deployment-error", () => {
    const row = deploys.normalizeVercel({
      type: "deployment.error",
      target: "production",
      deployment: { id: "dpl_x" },
    });
    expect(row.state).toBe("error");
  });

  it("flips state to cancelled when the Vercel type is canceled", () => {
    const row = deploys.normalizeVercel({
      type: "deployment.canceled",
      target: "preview",
      deployment: { id: "dpl_y" },
    });
    expect(row.state).toBe("cancelled");
    expect(row.environment).toBe("preview");
  });

  it("preserves the raw payload in meta.raw for forensics", () => {
    const payload = { type: "deployment.ready", target: "production", custom: 1 };
    const row = deploys.normalizeVercel(payload);
    expect(row.meta.raw).toEqual(payload);
  });
});
