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

/** Short label for chart axes: "14:05" for today (GMT+1), otherwise "03/11 14:05". */
export const axisTime = (d: Date | string | number, now = Date.now()) => {
  const t = new Date(d).getTime();
  if (t >= startOfDay(now).getTime()) return clock(t, false);
  const day = new Date(t).toLocaleDateString("en-GB", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit" });
  return `${day} ${clock(t, false)}`;
};

/** How far into the GMT+1 day we are, e.g. "10h 12m" (or "12m" in the first hour). */
export const sinceMidnight = (now = Date.now()) => {
  const min = Math.floor((now - startOfDay(now).getTime()) / 60_000);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
};
