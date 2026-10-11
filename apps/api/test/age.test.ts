import { describe, expect, it } from "vitest";
import {
  ageBracket,
  ageOn,
  isMinorRestricted,
  isValidDateString,
  meetsMinAge,
} from "../src/lib/age";

// Fixed "today" for deterministic tests: 2026-10-10.
const TODAY = new Date(Date.UTC(2026, 9, 10));

describe("ageOn", () => {
  it("computes whole years, respecting the birthday boundary", () => {
    expect(ageOn("1994-07-08", TODAY)).toBe(32);
    expect(ageOn("2013-10-10", TODAY)).toBe(13); // birthday today
    expect(ageOn("2013-10-11", TODAY)).toBe(12); // birthday tomorrow
  });
});

describe("meetsMinAge (D-011: min age 13)", () => {
  it("accepts exactly-13 and older", () => {
    expect(meetsMinAge("2013-10-10", 13, TODAY)).toBe(true);
    expect(meetsMinAge("1990-01-01", 13, TODAY)).toBe(true);
  });

  it("rejects under-13", () => {
    expect(meetsMinAge("2013-10-11", 13, TODAY)).toBe(false);
    expect(meetsMinAge("2020-06-01", 13, TODAY)).toBe(false);
  });

  it("honors a different configured floor", () => {
    expect(meetsMinAge("2010-01-01", 16, TODAY)).toBe(true);
    expect(meetsMinAge("2012-01-01", 16, TODAY)).toBe(false);
  });
});

describe("isMinorRestricted (13–17 restricted defaults)", () => {
  it("flags 13–17 only", () => {
    expect(isMinorRestricted("2012-01-01", TODAY)).toBe(true); // 14
    expect(isMinorRestricted("2009-01-01", TODAY)).toBe(true); // 17
    expect(isMinorRestricted("2008-10-10", TODAY)).toBe(false); // 18 today
    expect(isMinorRestricted("1994-07-08", TODAY)).toBe(false); // 32
  });
});

describe("ageBracket", () => {
  it("buckets ages as the API exposes them", () => {
    expect(ageBracket("2012-01-01", TODAY)).toBe("13_17");
    expect(ageBracket("2005-01-01", TODAY)).toBe("18_24");
    expect(ageBracket("1994-07-08", TODAY)).toBe("25_plus");
    expect(ageBracket(null, TODAY)).toBe("unknown");
  });
});

describe("isValidDateString", () => {
  it("rejects impossible and malformed dates", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("10/10/2013")).toBe(false);
    expect(isValidDateString("2013-1-1")).toBe(false);
    expect(isValidDateString("2013-10-10")).toBe(true);
  });
});
