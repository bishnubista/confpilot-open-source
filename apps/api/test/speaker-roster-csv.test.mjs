import { describe, expect, it } from "vitest";

import { parseSpeakerRosterCsv } from "../src/features/speakers/speaker-roster-csv.ts";

describe("speaker roster CSV parser", () => {
  it("parses BOM, CRLF, escaped quotes, commas, and embedded newlines with physical row numbers", () => {
    const rows = parseSpeakerRosterCsv(
      "\uFEFFemail,name,bio\r\n"
      + 'first@example.test,"Rivera, Zoë","Says ""hello"".\r\nSecond line"\r\n'
      + "second@example.test,李 明,Engineer\r\n",
    );

    expect(rows).toEqual([
      {
        rowNumber: 2,
        value: {
          email: "first@example.test",
          name: "Rivera, Zoë",
          bio: 'Says "hello".\r\nSecond line',
        },
      },
      {
        rowNumber: 4,
        value: { email: "second@example.test", name: "李 明", bio: "Engineer" },
      },
    ]);
  });

  it.each([
    ["unknown header", "name,email,phone\nA,a@example.test,123"],
    ["duplicate header", "name,email,email\nA,a@example.test,a@example.test"],
    ["missing required header", "name,bio\nA,Bio"],
  ])("rejects an %s deterministically", (_case, csv) => {
    expect(parseSpeakerRosterCsv(csv)).toEqual([{
      rowNumber: 1,
      value: {},
      parseError: "CSV headers must be unique and use name,email,title,company,bio; name and email are required.",
    }]);
  });

  it.each([
    ["unterminated quote", 'name,email\n"A,a@example.test', "Quoted CSV field is not terminated."],
    ["text after quote", 'name,email\n"A"x,a@example.test', "Unexpected text follows a quoted CSV field."],
    ["column mismatch", "name,email\nA", "Expected 2 columns but found 1."],
  ])("reports %s on the originating row", (_case, csv, message) => {
    expect(parseSpeakerRosterCsv(csv)).toEqual([{ rowNumber: 2, value: {}, parseError: message }]);
  });

  it("accepts 500 data rows and rejects 501 before ingestion", () => {
    const csvWith = (count) => `name,email\n${Array.from(
      { length: count },
      (_, index) => `Speaker ${index},speaker-${index}@example.test`,
    ).join("\n")}`;

    expect(parseSpeakerRosterCsv(csvWith(500))).toHaveLength(500);
    expect(parseSpeakerRosterCsv(csvWith(501))).toEqual([{
      rowNumber: 1,
      value: {},
      parseError: "CSV imports are limited to 500 data rows.",
    }]);
  });
});
