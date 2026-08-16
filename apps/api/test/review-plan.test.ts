import { describe, expect, it } from "vitest";

import { weightedScoreMilli } from "../src/features/review/review-plan";

describe("review plan scoring", () => {
  const criteria = [
    { id: "criterion-evidence", weightBasisPoints: 3333, minimumScore: 1, maximumScore: 5 },
    { id: "criterion-impact", weightBasisPoints: 6667, minimumScore: 1, maximumScore: 5 },
  ];

  it("rounds the weighted aggregate to the nearest fixed thousandth using integers", () => {
    expect(weightedScoreMilli(criteria, [
      { criterionId: "criterion-impact", score: 5 },
      { criterionId: "criterion-evidence", score: 2 },
    ])).toBe(4000);
    expect(weightedScoreMilli([
      { id: "criterion-heavy", weightBasisPoints: 9995, minimumScore: 1, maximumScore: 2 },
      { id: "criterion-light", weightBasisPoints: 5, minimumScore: 1, maximumScore: 2 },
    ], [
      { criterionId: "criterion-heavy", score: 1 },
      { criterionId: "criterion-light", score: 2 },
    ])).toBe(1002);
  });

  it("normalizes mixed criterion ranges onto the same one-to-five scale", () => {
    expect(weightedScoreMilli([
      { id: "criterion-five-point", weightBasisPoints: 5000, minimumScore: 1, maximumScore: 5 },
      { id: "criterion-ten-point", weightBasisPoints: 5000, minimumScore: 1, maximumScore: 10 },
    ], [
      { criterionId: "criterion-five-point", score: 5 },
      { criterionId: "criterion-ten-point", score: 10 },
    ])).toBe(5000);
  });

  it("rejects missing, duplicate, unknown, and out-of-range criterion scores", () => {
    expect(weightedScoreMilli(criteria, [{ criterionId: "criterion-evidence", score: 4 }])).toBeNull();
    expect(weightedScoreMilli(criteria, [
      { criterionId: "criterion-evidence", score: 4 },
      { criterionId: "criterion-evidence", score: 4 },
    ])).toBeNull();
    expect(weightedScoreMilli(criteria, [
      { criterionId: "criterion-evidence", score: 4 },
      { criterionId: "unknown", score: 4 },
    ])).toBeNull();
    expect(weightedScoreMilli(criteria, [
      { criterionId: "criterion-evidence", score: 4 },
      { criterionId: "criterion-impact", score: 6 },
    ])).toBeNull();
  });

  it("rejects degenerate and reversed criterion ranges before normalization", () => {
    for (const [minimumScore, maximumScore] of [[3, 3], [5, 2]]) {
      expect(weightedScoreMilli([
        { id: "criterion-invalid", weightBasisPoints: 10_000, minimumScore, maximumScore },
      ], [
        { criterionId: "criterion-invalid", score: 3 },
      ])).toBeNull();
    }
  });
});
