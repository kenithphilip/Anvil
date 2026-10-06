// Guards toGeminiSchema — the fix for the live extraction failure where every
// Gemini call 400'd with:
//   Invalid JSON payload received. Unknown name "type" at
//   'generation_config.response_schema.properties[2].value': Proto field is not
//   repeating, cannot start [array]
// because our extraction schemas express nullable fields as a JSON-Schema union
// `type: ["string","null"]`, which Gemini's responseSchema rejects.

import { describe, it, expect } from "vitest";
import { toGeminiSchema } from "../api/_lib/gemini.js";

// Recursively assert no node carries an array-typed `type` (the failure).
const assertNoArrayType = (node) => {
  if (Array.isArray(node)) return node.forEach(assertNoArrayType);
  if (!node || typeof node !== "object") return;
  expect(Array.isArray(node.type), `array type survived: ${JSON.stringify(node.type)}`).toBe(false);
  if (node.properties) Object.values(node.properties).forEach(assertNoArrayType);
  if (node.items) assertNoArrayType(node.items);
};

describe("toGeminiSchema", () => {
  it("collapses a nullable union to a scalar type + nullable flag", () => {
    expect(toGeminiSchema({ type: ["string", "null"] })).toEqual({ type: "string", nullable: true });
    expect(toGeminiSchema({ type: ["object", "null"] })).toEqual({ type: "object", nullable: true });
  });

  it("leaves a plain scalar type untouched", () => {
    expect(toGeminiSchema({ type: "number" })).toEqual({ type: "number" });
  });

  it("preserves enum, description, format, required, minItems", () => {
    const out = toGeminiSchema({
      type: "string", enum: ["po", "rfq", "non_po"], description: "class", format: "date",
    });
    expect(out).toEqual({ type: "string", enum: ["po", "rfq", "non_po"], description: "class", format: "date" });
  });

  it("recurses into nested properties and array items", () => {
    const out = toGeminiSchema({
      type: ["object", "null"],
      properties: {
        name: { type: ["string", "null"], description: "buyer" },
        lineItems: {
          type: ["array", "null"],
          items: { type: "object", properties: { qty: { type: ["number", "null"] } } },
        },
      },
      required: ["name"],
    });
    expect(out.type).toBe("object");
    expect(out.nullable).toBe(true);
    expect(out.properties.name).toEqual({ type: "string", nullable: true, description: "buyer" });
    expect(out.properties.lineItems.type).toBe("array");
    expect(out.properties.lineItems.nullable).toBe(true);
    expect(out.properties.lineItems.items.properties.qty).toEqual({ type: "number", nullable: true });
    expect(out.required).toEqual(["name"]);
  });

  it("drops JSON-Schema keywords Gemini rejects", () => {
    const out = toGeminiSchema({
      type: "object",
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
      $ref: "#/definitions/x",
      properties: { a: { type: "string" } },
    });
    expect(out.additionalProperties).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect(out.$ref).toBeUndefined();
    expect(out.properties.a).toEqual({ type: "string" });
  });

  it("regression: a PO_SCHEMA-shaped schema yields NO array-typed `type` anywhere", () => {
    // Mirrors docai/gemini.js PO_SCHEMA (properties[2] = customer, the failing node).
    const poShaped = {
      type: "object",
      properties: {
        classification: { type: "string", enum: ["po", "rfq", "non_po"] },
        confidence: { type: "number" },
        customer: {
          type: ["object", "null"],
          properties: {
            name: { type: ["string", "null"] },
            gstin: { type: ["string", "null"], description: "Required iff country==IN" },
          },
        },
        lineItems: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              partNumber: { type: ["string", "null"] },
              qty: { type: ["number", "null"] },
            },
          },
        },
      },
    };
    assertNoArrayType(toGeminiSchema(poShaped));
  });

  it("handles non-object input gracefully", () => {
    expect(toGeminiSchema(null)).toBe(null);
    expect(toGeminiSchema("x")).toBe("x");
  });
});
