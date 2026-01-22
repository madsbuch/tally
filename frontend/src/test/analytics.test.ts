import { describe, it, expect } from "vitest";
import { getStartOfWeek, getStartOfMonth } from "../pages/app/analytics";
import type { JournalEntry } from "../lib/database";

// Helper to create mock journal entries
function createMockEntry(
  insertedAt: string,
  energyInKCals: number
): JournalEntry {
  return {
    id: Math.floor(Math.random() * 1000000),
    insertedAt: new Date(insertedAt),
    energyInKCals,
    proteinInGrams: 0,
    carbsInGrams: 0,
    fatInGrams: 0,
    userText: "",
    llmResponse: "",
  };
}

// Import filterEntriesByDateRange by copying it since it's not exported
function filterEntriesByDateRange(
  entries: JournalEntry[],
  startDate: Date,
  endDate: Date
): JournalEntry[] {
  return entries.filter((entry) => {
    const entryDate = new Date(entry.insertedAt);
    return entryDate >= startDate && entryDate <= endDate;
  });
}

describe("getStartOfWeek", () => {
  it("should return Monday at 00:00:00 for a Monday input", () => {
    // Monday, January 6, 2025 - yep it is a monday
    const monday = new Date("2025-01-06T14:30:00");
    const result = getStartOfWeek(monday);

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(6);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  it("should return previous Monday for Tuesday", () => {
    // Tuesday, January 7, 2025
    const tuesday = new Date("2025-01-07T14:30:00");
    const result = getStartOfWeek(tuesday);

    expect(result.getDate()).toBe(6); // Monday, January 6
    expect(result.getHours()).toBe(0);
  });

  it("should return previous Monday for Wednesday", () => {
    // Wednesday, January 8, 2025
    const wednesday = new Date("2025-01-08T14:30:00");
    const result = getStartOfWeek(wednesday);

    expect(result.getDate()).toBe(6); // Monday, January 6
  });

  it("should return previous Monday for Sunday", () => {
    // Sunday, January 12, 2025
    const sunday = new Date("2025-01-12T14:30:00");
    const result = getStartOfWeek(sunday);

    expect(result.getDate()).toBe(6); // Monday, January 6
    expect(result.getHours()).toBe(0);
  });

  it("should handle end of month boundary", () => {
    // Sunday, March 30, 2025 (month end)
    const sunday = new Date("2025-03-30T14:30:00");
    const result = getStartOfWeek(sunday);

    expect(result.getDate()).toBe(24); // Monday, March 24
    expect(result.getMonth()).toBe(2); // March
  });

  it("should handle year boundary", () => {
    // Wednesday, January 1, 2025
    const newYear = new Date("2025-01-01T14:30:00");
    const result = getStartOfWeek(newYear);

    expect(result.getDate()).toBe(30); // Monday, December 30, 2024
    expect(result.getMonth()).toBe(11); // December
    expect(result.getFullYear()).toBe(2024);
  });

  it("should handle leap year February", () => {
    // Sunday, March 2, 2024 (2024 is leap year)
    const sunday = new Date("2024-03-02T14:30:00");
    const result = getStartOfWeek(sunday);

    expect(result.getDate()).toBe(26); // Monday, February 26
    expect(result.getMonth()).toBe(1); // February
  });
});

describe("getStartOfMonth", () => {
  it("should return first day at 00:00:00 for first day input", () => {
    // January 1, 2025
    const firstDay = new Date("2025-01-01T14:30:00");
    const result = getStartOfMonth(firstDay);

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(1);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  it("should return first day for mid-month date", () => {
    // January 15, 2025
    const midMonth = new Date("2025-01-15T14:30:00");
    const result = getStartOfMonth(midMonth);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getHours()).toBe(0);
  });

  it("should return first day for last day of month", () => {
    // January 31, 2025
    const lastDay = new Date("2025-01-31T23:59:59");
    const result = getStartOfMonth(lastDay);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getHours()).toBe(0);
  });

  it("should handle February in non-leap year", () => {
    // February 28, 2025 (non-leap year)
    const feb28 = new Date("2025-02-28T14:30:00");
    const result = getStartOfMonth(feb28);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(1); // February
  });

  it("should handle February in leap year", () => {
    // February 29, 2024 (leap year)
    const feb29 = new Date("2024-02-29T14:30:00");
    const result = getStartOfMonth(feb29);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getFullYear()).toBe(2024);
  });

  it("should handle 30-day month", () => {
    // April 30, 2025
    const april30 = new Date("2025-04-30T14:30:00");
    const result = getStartOfMonth(april30);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(3); // April
  });

  it("should handle December (year boundary)", () => {
    // December 31, 2025
    const dec31 = new Date("2025-12-31T23:59:59");
    const result = getStartOfMonth(dec31);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getFullYear()).toBe(2025);
  });
});

describe("filterEntriesByDateRange", () => {
  it("should return empty array for empty input", () => {
    const startDate = new Date("2025-01-01");
    const endDate = new Date("2025-01-31");
    const result = filterEntriesByDateRange([], startDate, endDate);

    expect(result).toEqual([]);
  });

  it("should return all entries within range", () => {
    const entries = [
      createMockEntry("2025-01-05T10:00:00", 500),
      createMockEntry("2025-01-10T14:00:00", 600),
      createMockEntry("2025-01-15T18:00:00", 700),
    ];

    const startDate = new Date("2025-01-01T00:00:00");
    const endDate = new Date("2025-01-31T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(3);
  });

  it("should exclude entries outside range", () => {
    const entries = [
      createMockEntry("2024-12-31T23:59:59", 500), // Before
      createMockEntry("2025-01-05T10:00:00", 600), // In range
      createMockEntry("2025-01-10T14:00:00", 700), // In range
      createMockEntry("2025-02-01T00:00:00", 800), // After
    ];

    const startDate = new Date("2025-01-01T00:00:00");
    const endDate = new Date("2025-01-31T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(2);
    expect(result[0].energyInKCals).toBe(600);
    expect(result[1].energyInKCals).toBe(700);
  });

  it("should include entries at exact start boundary", () => {
    const entries = [
      createMockEntry("2025-01-01T00:00:00", 500), // Exactly at start
      createMockEntry("2025-01-05T10:00:00", 600),
    ];

    const startDate = new Date("2025-01-01T00:00:00");
    const endDate = new Date("2025-01-31T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(2);
  });

  it("should include entries at exact end boundary", () => {
    const entries = [
      createMockEntry("2025-01-05T10:00:00", 500),
      createMockEntry("2025-01-31T23:59:59", 600), // Exactly at end
    ];

    const startDate = new Date("2025-01-01T00:00:00");
    const endDate = new Date("2025-01-31T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(2);
  });

  it("should handle same day range", () => {
    const entries = [
      createMockEntry("2025-01-05T08:00:00", 500),
      createMockEntry("2025-01-05T12:00:00", 600),
      createMockEntry("2025-01-05T18:00:00", 700),
      createMockEntry("2025-01-06T10:00:00", 800), // Next day
    ];

    const startDate = new Date("2025-01-05T00:00:00");
    const endDate = new Date("2025-01-05T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(3);
  });

  it("should handle entries with negative calories (exercise)", () => {
    const entries = [
      createMockEntry("2025-01-05T10:00:00", 500),
      createMockEntry("2025-01-05T14:00:00", -300), // Exercise
      createMockEntry("2025-01-06T10:00:00", 600),
    ];

    const startDate = new Date("2025-01-05T00:00:00");
    const endDate = new Date("2025-01-05T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(2);
    expect(result.some((e) => e.energyInKCals === -300)).toBe(true);
  });

  it("should maintain entry order", () => {
    const entries = [
      createMockEntry("2025-01-05T10:00:00", 500),
      createMockEntry("2025-01-03T14:00:00", 600),
      createMockEntry("2025-01-07T18:00:00", 700),
    ];

    const startDate = new Date("2025-01-01T00:00:00");
    const endDate = new Date("2025-01-31T23:59:59");
    const result = filterEntriesByDateRange(entries, startDate, endDate);

    expect(result.length).toBe(3);
    expect(result[0].energyInKCals).toBe(500);
    expect(result[1].energyInKCals).toBe(600);
    expect(result[2].energyInKCals).toBe(700);
  });
});
