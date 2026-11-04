import assert from "node:assert/strict";
import { test } from "node:test";
import { usdAmt } from "../lib/fmt";
import { axisTime, clock, sinceMidnight, startOfDay, TZ_LABEL } from "../lib/time";

const utc = (s: string) => new Date(s + "Z").getTime();

test("startOfDay is midnight GMT+1 (23:00 UTC the day before)", () => {
  assert.equal(startOfDay(utc("2026-11-04T12:00:00")).toISOString(), "2026-11-03T23:00:00.000Z");
});

test("startOfDay rolls over at 23:00 UTC, not 00:00 UTC", () => {
  // 22:59 UTC = 23:59 GMT+1 → still Nov 3
  assert.equal(startOfDay(utc("2026-11-03T22:59:00")).toISOString(), "2026-11-02T23:00:00.000Z");
  // 23:00 UTC = 00:00 GMT+1 → Nov 4 begins
  assert.equal(startOfDay(utc("2026-11-03T23:00:00")).toISOString(), "2026-11-03T23:00:00.000Z");
});

test("clock shows GMT+1 wall time, 24h", () => {
  assert.equal(clock(utc("2026-11-04T13:05:09")), "14:05:09");
  assert.equal(clock(utc("2026-11-04T13:05:09"), false), "14:05");
  assert.equal(clock(utc("2026-11-04T23:30:00"), false), "00:30");
  assert.equal(TZ_LABEL, "GMT+1");
});

test("axisTime shows time only for today, date + time otherwise", () => {
  const now = utc("2026-11-04T15:00:00"); // 16:00 GMT+1
  assert.equal(axisTime(utc("2026-11-04T08:10:00"), now), "09:10");
  assert.equal(axisTime(utc("2026-11-03T23:00:00"), now), "00:00"); // first minute of today GMT+1
  assert.equal(axisTime(utc("2026-11-03T22:59:00"), now), "03/11 23:59");
  assert.equal(axisTime(utc("2026-10-28T10:00:00"), now), "28/10 11:00");
});

test("usdAmt formats signs, cents and large values", () => {
  assert.equal(usdAmt(9.274), "$9.27");
  assert.equal(usdAmt(9.274, true), "+$9.27");
  assert.equal(usdAmt(-27.87, true), "-$27.87");
  assert.equal(usdAmt(0, true), "$0.00");
  assert.equal(usdAmt(1234.5), "$1,234.50");
  assert.equal(usdAmt(25_300), "$25.3K");
  assert.equal(usdAmt(2_500_000), "$2.50M");
});

test("sinceMidnight counts from 00:00 GMT+1", () => {
  assert.equal(sinceMidnight(utc("2026-11-04T09:12:30")), "10h 12m"); // 10:12 GMT+1
  assert.equal(sinceMidnight(utc("2026-11-03T23:12:00")), "12m"); // 00:12 GMT+1
  assert.equal(sinceMidnight(utc("2026-11-03T23:00:00")), "0m");
  assert.equal(sinceMidnight(utc("2026-11-04T22:59:00")), "23h 59m");
});
