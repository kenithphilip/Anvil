// Regression test for the storage bucket auto-create helper.
// The user reported "Could not continue, Signed URL, The related
// resource does not exist" when uploading a PO. Root cause: the
// canonical bucket (`anvil-documents`) didn't exist on the
// deployment and createSignedUploadUrl returns a not-found error.
// `ensureDocumentsBucket` probes listBuckets first and creates the
// bucket if missing, so first-run uploads stop failing.

import { describe, it, expect, beforeEach } from "vitest";
import { ensureDocumentsBucket, documentsBucket, legacyDocumentsBucket } from "../api/_lib/storage.js";

const makeFakeStorage = (have, opts = {}) => {
  const created = [];
  return {
    storage: {
      listBuckets: async () => ({
        data: have.map((name) => ({ id: name, name, public: false })),
        error: null,
      }),
      createBucket: async (name, options) => {
        if (opts.failCreate) return { error: { message: "createBucket forbidden" } };
        created.push({ name, options });
        have.push(name);
        return { error: null };
      },
    },
    _created: () => created,
  };
};

describe("ensureDocumentsBucket", () => {
  it("returns the canonical bucket when it already exists", async () => {
    const svc = makeFakeStorage([documentsBucket()]);
    const out = await ensureDocumentsBucket(svc);
    expect(out).toBe(documentsBucket());
    expect(svc._created()).toEqual([]);
  });

  it("returns the legacy bucket when only it exists", async () => {
    const svc = makeFakeStorage([legacyDocumentsBucket()]);
    const out = await ensureDocumentsBucket(svc);
    expect(out).toBe(legacyDocumentsBucket());
    expect(svc._created()).toEqual([]);
  });

  it("creates the canonical bucket when neither exists", async () => {
    const svc = makeFakeStorage([]);
    const out = await ensureDocumentsBucket(svc);
    expect(out).toBe(documentsBucket());
    expect(svc._created().length).toBe(1);
    expect(svc._created()[0].name).toBe(documentsBucket());
    expect(svc._created()[0].options).toEqual({ public: false });
  });

  it("falls back to the legacy bucket when canonical creation is forbidden", async () => {
    let attempts = 0;
    const svc = {
      storage: {
        listBuckets: async () => ({ data: [], error: null }),
        createBucket: async (name) => {
          attempts += 1;
          if (name === documentsBucket()) return { error: { message: "permission denied" } };
          return { error: null };
        },
      },
    };
    const out = await ensureDocumentsBucket(svc);
    expect(out).toBe(legacyDocumentsBucket());
    expect(attempts).toBe(2);
  });

  it("throws an actionable error when both creates fail", async () => {
    const svc = {
      storage: {
        listBuckets: async () => ({ data: [], error: null }),
        createBucket: async () => ({ error: { message: "permission denied" } }),
      },
    };
    await expect(ensureDocumentsBucket(svc)).rejects.toThrow(/Documents storage bucket missing/);
  });

  it("recovers from a listBuckets failure and tries to create", async () => {
    let createdName = null;
    const svc = {
      storage: {
        listBuckets: async () => { throw new Error("boom"); },
        createBucket: async (name) => { createdName = name; return { error: null }; },
      },
    };
    const out = await ensureDocumentsBucket(svc);
    expect(out).toBe(documentsBucket());
    expect(createdName).toBe(documentsBucket());
  });
});
