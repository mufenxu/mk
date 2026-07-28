import assert from "node:assert/strict";
import test from "node:test";

import {
  dueOccurrence,
  isScheduledDate,
  nextOccurrence,
  renderPrompt,
  shouldRunSchedule,
  zonedLocalToDate,
} from "../src/schedule.mjs";

const schedule = {
  mode: "weekdays",
  time: "09:00",
  timeZone: "Asia/Shanghai",
  weekdays: [1, 2, 3, 4, 5],
  catchUp: true,
  includeDates: ["2026-08-01"],
  excludeDates: ["2026-07-28"],
};

test("converts a zoned schedule to the correct instant", () => {
  assert.equal(
    zonedLocalToDate("2026-07-27", "09:00", "Asia/Shanghai").toISOString(),
    "2026-07-27T01:00:00.000Z",
  );
});

test("applies workday rules and explicit date overrides", () => {
  assert.equal(isScheduledDate(schedule, "2026-07-27"), true);
  assert.equal(isScheduledDate(schedule, "2026-07-28"), false);
  assert.equal(isScheduledDate(schedule, "2026-08-01"), true);
  assert.equal(isScheduledDate(schedule, "2026-08-02"), false);
});

test("supports catch-up without running twice on the same local date", () => {
  const now = new Date("2026-07-27T06:00:00.000Z");
  assert.equal(shouldRunSchedule(schedule, null, now), true);
  assert.equal(shouldRunSchedule(schedule, "2026-07-27", now), false);
});

test("finds the next allowed occurrence", () => {
  const next = nextOccurrence(schedule, new Date("2026-07-27T02:00:00.000Z"));
  assert.equal(next.localDate, "2026-07-29");
  assert.equal(next.at, "2026-07-29T01:00:00.000Z");
});

test("runs each configured time once and finds the next time on the same day", () => {
  const multiple = { ...schedule, mode: "daily", times: ["09:00", "18:00"], excludeDates: [] };
  const morningKey = "2026-07-27@09:00";
  const due = dueOccurrence(multiple, [morningKey], new Date("2026-07-27T12:00:00.000Z"));
  assert.equal(due.key, "2026-07-27@18:00");
  assert.equal(nextOccurrence(multiple, new Date("2026-07-27T02:00:00.000Z")).localTime, "18:00");
});

test("renders task prompt variables in the task timezone", () => {
  const prompt = renderPrompt(
    "{{task_name}} {{date}} {{time}} {{weekday}}",
    "日报",
    new Date("2026-07-27T01:05:00.000Z"),
    "Asia/Shanghai",
  );
  assert.equal(prompt, "日报 2026-07-27 09:05 星期一");
});
