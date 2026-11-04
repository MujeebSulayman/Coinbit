/** Display + "day" timezone for the whole app. Africa/Lagos is a fixed UTC+1 (no daylight saving). */
export const TIME_ZONE = "Africa/Lagos";
export const TZ_LABEL = "GMT+1";
const OFFSET_MS = 60 * 60 * 1000;

/** Midnight GMT+1 of the current day, as a Date (used for "Today" and the daily loss limit). */
export function startOfDay(now = Date.now()) {
  const day = 864e5;
  return new Date(Math.floor((now + OFFSET_MS) / day) * day - OFFSET_MS);
}

export const clock = (d: Date | string | number, seconds = true) =>
  new Date(d).toLocaleTimeString("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: false,
  });

export const dateTime = (d: Date | string | number) =>
  new Date(d).toLocaleString("en-GB", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short", hour12: false });
