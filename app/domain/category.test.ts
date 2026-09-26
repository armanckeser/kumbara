// Regression tests for the unified Category domain schema (domain/category.ts).
//
// Guards that a category row streamed by Electric decodes with the FULL column set after the 0003
// migration: the `archival_status` enum (both values) in place of the dropped `archived` boolean, plus the
// nullable presentational/hierarchy fields (parent_id/icon/color). If the shared schema drifts from the DB
// columns, Electric decode breaks in the browser — so this pins the wire shape. Public API only (Schema
// decode), hardcoded expectations, and the negative case (an invalid archival_status must reject).

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { CategoryRow } from "./category";

const decodeCategory = Schema.decodeUnknownSync(CategoryRow);

const baseRow = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Groceries",
  parent_id: null,
  bucket: "needs" as const,
  predictability: "variable" as const,
  person_id: null,
  icon: null,
  color: null,
  actual_source: "derived" as const,
  archival_status: "active" as const,
  sort_order: null,
  created_at: "2026-06-30T00:00:00Z",
  updated_at: "2026-06-30T00:00:00Z",
};

describe("CategoryRow decode", () => {
  it.each([
    { archival_status: "active" as const },
    { archival_status: "archived" as const },
  ])("decodes with archival_status=$archival_status", ({ archival_status }) => {
    const category = decodeCategory({ ...baseRow, archival_status });
    assert.strictEqual(category.archival_status, archival_status);
    assert.strictEqual(category.bucket, "needs");
  });

  it("decodes with null parent_id, icon, and color", () => {
    const category = decodeCategory(baseRow);
    assert.strictEqual(category.parent_id, null);
    assert.strictEqual(category.icon, null);
    assert.strictEqual(category.color, null);
  });

  it("decodes populated parent_id, icon, and color", () => {
    const category = decodeCategory({
      ...baseRow,
      parent_id: "22222222-2222-2222-2222-222222222222",
      icon: "cart",
      color: "#22c55e",
    });
    assert.strictEqual(category.icon, "cart");
    assert.strictEqual(category.color, "#22c55e");
  });

  it("rejects an unknown archival_status (enum, not free text)", () => {
    assert.throws(() => decodeCategory({ ...baseRow, archival_status: "deleted" }));
  });

  it.each([
    { actual_source: "derived" as const },
    { actual_source: "manual" as const },
  ])("decodes actual_source=$actual_source (Pitch 13 wire column)", ({ actual_source }) => {
    // Guards that the 0030 actual_source column is on the shared wire shape — without it, Electric decode of
    // a manual-actual (401k) category breaks in the browser and the board can't tell manual from derived.
    const category = decodeCategory({ ...baseRow, actual_source });
    assert.strictEqual(category.actual_source, actual_source);
  });

  it("rejects an unknown actual_source (enum, not a boolean or free text)", () => {
    // Negative case + the R8 contract: actual_source is an enum, never a manual_actual boolean.
    assert.throws(() => decodeCategory({ ...baseRow, actual_source: "auto" }));
  });

  it("decodes a null sort_order (a never-dragged category has no explicit position)", () => {
    const category = decodeCategory(baseRow);
    assert.strictEqual(category.sort_order, null);
  });

  it("decodes an integer sort_order (the hand-chosen position)", () => {
    const category = decodeCategory({ ...baseRow, sort_order: 3 });
    assert.strictEqual(category.sort_order, 3);
  });

  it("rejects a non-integer sort_order (it is an ordinal position, not a float)", () => {
    assert.throws(() => decodeCategory({ ...baseRow, sort_order: 1.5 }));
  });
});
