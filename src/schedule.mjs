import { ConfigError } from "./errors.mjs";

const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new ConfigError("Invalid IANA timezone");
  }
  return timeZone;
}

export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function localDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new ConfigError(`Invalid date: ${dateKey}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addLocalDays(dateKey, amount) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

export function isoWeekday(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function isScheduledDate(schedule, dateKey) {
  const included = new Set(schedule.includeDates ?? []);
  const excluded = new Set(schedule.excludeDates ?? []);
  if (included.has(dateKey)) return true;
  if (excluded.has(dateKey)) return false;

  const weekday = isoWeekday(dateKey);
  if (schedule.mode === "daily") return true;
  if (schedule.mode === "weekdays") return weekday <= 5;
  return (schedule.weekdays ?? []).includes(weekday);
}

export function scheduleTimes(schedule) {
  const source = Array.isArray(schedule?.times) && schedule.times.length
    ? schedule.times
    : [schedule?.time ?? "09:00"];
  return [...new Set(source)].sort();
}

export function zonedLocalToDate(dateKey, time, timeZone) {
  const { year, month, day } = parseDateKey(dateKey);
  const [hour, minute] = time.split(":").map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = targetAsUtc;

  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(new Date(result), timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const adjustment = targetAsUtc - represented;
    result += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(result);
}

export function scheduledOccurrence(schedule, dateKey, time = scheduleTimes(schedule)[0]) {
  return zonedLocalToDate(dateKey, time, schedule.timeZone);
}

export function occurrenceKey(dateKey, time) {
  return `${dateKey}@${time}`;
}

export function dueOccurrence(schedule, completedOccurrences = [], now = new Date()) {
  const dateKey = localDateKey(now, schedule.timeZone);
  if (!isScheduledDate(schedule, dateKey)) return null;
  const completed = new Set(completedOccurrences);
  for (const time of scheduleTimes(schedule)) {
    const key = occurrenceKey(dateKey, time);
    if (completed.has(key)) continue;
    const occurrence = scheduledOccurrence(schedule, dateKey, time);
    if (now < occurrence) continue;
    if (!schedule.catchUp && now.getTime() - occurrence.getTime() >= 120_000) continue;
    return { key, at: occurrence.toISOString(), localDate: dateKey, localTime: time, timeZone: schedule.timeZone };
  }
  return null;
}

export function shouldRunSchedule(schedule, lastRunDateOrOccurrence, now = new Date()) {
  const completed = lastRunDateOrOccurrence
    ? lastRunDateOrOccurrence.includes("@")
      ? [lastRunDateOrOccurrence]
      : scheduleTimes(schedule).map((time) => occurrenceKey(lastRunDateOrOccurrence, time))
    : [];
  return Boolean(dueOccurrence(schedule, completed, now));
}

export function nextOccurrence(schedule, now = new Date()) {
  const today = localDateKey(now, schedule.timeZone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const dateKey = addLocalDays(today, offset);
    if (!isScheduledDate(schedule, dateKey)) continue;
    for (const time of scheduleTimes(schedule)) {
      const occurrence = scheduledOccurrence(schedule, dateKey, time);
      if (occurrence > now) {
        return {
          at: occurrence.toISOString(),
          localDate: dateKey,
          localTime: time,
          timeZone: schedule.timeZone,
        };
      }
    }
  }
  return null;
}

export function renderPrompt(template, taskName, now, timeZone) {
  const parts = zonedParts(now, timeZone);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const values = {
    date,
    iso_date: date,
    time: `${parts.hour}:${parts.minute}`,
    weekday: WEEKDAY_NAMES[isoWeekday(date) % 7],
    task_name: taskName,
  };
  return template.replace(/\{\{\s*(date|iso_date|time|weekday|task_name)\s*\}\}/g, (_match, key) => values[key]);
}
