/**
 * 时间锚 / 允许时段的统一求值层（文档 12.2–12.5）。
 *
 * 预览、可满足率、逐日窗口判定三处必须得到完全一致的天文结论，因此它们共用
 * evaluateDay()，不允许各自再写一份「锚点解析 → 采样 → 仰角/方位角求交」逻辑。
 *
 * 约定：
 * - 多段时段之间是「或」：任一段在当天能交出连续窗口，当天即天文可满足；
 * - 方位角区间 [from,to] 按「from 顺时针走到 to」解释，可自然跨过 0°/360°（跨午夜接缝）；
 * - 极昼/极夜导致某段锚点无法解析时，该段状态为 anchor_unresolved，其余段照常求值；
 * - 全部采样都基于绝对 UTC 时刻，允许窗口的 start/end 落在本地日期之外（跨午夜）。
 */

import { azimuthWithinArc } from './geometry.js';
import { addMinutes } from './time.js';
import {
  bandToRange,
  elevationInRange,
  resolveAnchor,
  sampleWindow,
  solarPosition,
  sunEvents,
  type AnchorResolution,
  type SolarPosition,
  type SunEvents,
  type WindowSample,
} from './astro.js';
import { TIME_ANCHOR_LABEL, type TimeAnchor } from './enums.js';
import type { TimingDto, TimingInterval } from './types.js';

const CONTIGUOUS_GAP_MIN = 6;

/** 无显式多段时，由旧版顶层字段合成唯一段（保证旧数据/旧调用方零改动）。 */
export function intervalFromLegacy(timing: TimingDto): TimingInterval {
  return {
    timeAnchor: timing.timeAnchor,
    anchorOffsetMin: timing.anchorOffsetMin,
    elevationRange: timing.elevationRange,
    azimuthRange: timing.azimuthRange,
    azimuthTolerance: timing.azimuthTolerance,
    windowToleranceMin: timing.windowToleranceMin,
    label: null,
  };
}

/**
 * 归一化：返回带 intervals 的 TimingDto；同时让顶层旧字段镜像第一段，
 * 使 calibration / albums / serialization 等只读顶层字段的旧代码继续成立。
 */
export function normalizeTiming(timing: TimingDto): TimingDto {
  const intervals =
    Array.isArray(timing.intervals) && timing.intervals.length > 0
      ? timing.intervals.map((iv) => ({ label: null, ...iv }))
      : [intervalFromLegacy(timing)];
  const first = intervals[0];
  return {
    ...timing,
    intervals,
    timeAnchor: first.timeAnchor,
    anchorOffsetMin: first.anchorOffsetMin,
    elevationRange: first.elevationRange,
    azimuthRange: first.azimuthRange,
    azimuthTolerance: first.azimuthTolerance,
    windowToleranceMin: first.windowToleranceMin,
  };
}

/** 人类可读的锚点描述（预览与判定理由共用同一份措辞）。 */
export function describeIntervalAnchor(iv: Pick<TimingInterval, 'timeAnchor' | 'anchorOffsetMin'>): string {
  const off = iv.anchorOffsetMin;
  switch (iv.timeAnchor) {
    case 'sunrise_plus':
      return `日出后 ${Math.max(0, off)} 分`;
    case 'sunset_minus':
      return `日落前 ${Math.abs(off)} 分`;
    case 'fixed_clock': {
      const total = ((Math.round(off) % 1440) + 1440) % 1440;
      const hh = String(Math.floor(total / 60)).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      return `固定钟点 ${hh}:${mm}`;
    }
    default:
      return TIME_ANCHOR_LABEL[iv.timeAnchor as TimeAnchor] ?? iv.timeAnchor;
  }
}

/** 找出满足条件的最长连续时间段（跨午夜同样成立，因为只比较绝对时刻）。 */
export function longestRun(
  samples: { at: Date; ok: boolean }[],
): { start: Date; end: Date } | null {
  let best: { start: Date; end: Date } | null = null;
  let runStart: Date | null = null;
  let prevAt: Date | null = null;

  const consider = (candidate: { start: Date; end: Date }) => {
    if (!best || candidate.end.getTime() - candidate.start.getTime() > best.end.getTime() - best.start.getTime()) {
      best = candidate;
    }
  };

  for (const s of samples) {
    if (s.ok) {
      if (!runStart) runStart = s.at;
      else if (prevAt && (s.at.getTime() - prevAt.getTime()) / 60000 > CONTIGUOUS_GAP_MIN) {
        consider({ start: runStart, end: prevAt });
        runStart = s.at;
      }
      prevAt = s.at;
    } else if (runStart && prevAt) {
      consider({ start: runStart, end: prevAt });
      runStart = null;
      prevAt = null;
    }
  }
  if (runStart && prevAt) consider({ start: runStart, end: prevAt });
  return best;
}

export type IntervalStatus = 'ok' | 'anchor_unresolved' | 'elevation_miss' | 'azimuth_miss';

export interface IntervalEvaluation {
  index: number;
  interval: TimingInterval;
  status: IntervalStatus;
  resolved: AnchorResolution | null;
  anchorAt: Date | null;
  band: { start: Date; end: Date } | null;
  /** 实际生效的仰角区间（锚点自带仰角优先） */
  effectiveElevationRange: [number, number] | null;
  /** 采样点上的命中标记 */
  samples: (WindowSample & { ok: boolean })[];
  run: { start: Date; end: Date } | null;
  /** 锚点解析过程中产生的说明（极昼/极夜、夜间截取等） */
  notes: string[];
  /** 供理由文案复算用的实测值 */
  measured: {
    anchorPosition: SolarPosition | null;
    elevationMin: number | null;
    elevationMax: number | null;
    azimuthMin: number | null;
    azimuthMax: number | null;
  };
}

/** 方位角命中：落在允许弧上，弧的两侧各外扩 tolerance 度（同样按顺时针弧处理跨 0°）。 */
export function azimuthIntervalMatches(
  valueDeg: number,
  iv: Pick<TimingInterval, 'azimuthRange' | 'azimuthTolerance'>,
): boolean {
  if (!iv.azimuthRange) return true;
  const [from, to] = iv.azimuthRange;
  const width = (((to - from) % 360) + 360) % 360;
  const tol = iv.azimuthTolerance ?? 0;
  return azimuthWithinArc(valueDeg, from - tol, width + tol * 2);
}

/** 两个仰角区间的交集；无交集返回 null。 */
function intersectElevation(
  a: readonly [number, number],
  b: readonly [number, number],
): [number, number] | null {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi >= lo - 1e-9 ? [lo, hi] : null;
}

/** 单段在某地某天的天文求值。events 由调用方传入，保证多段共用同一份太阳事件。 */
export function evaluateInterval(
  index: number,
  interval: TimingInterval,
  lat: number,
  lng: number,
  events: SunEvents,
): IntervalEvaluation {
  const resolved = resolveAnchor(events, interval);
  const base: IntervalEvaluation = {
    index,
    interval,
    status: 'anchor_unresolved',
    resolved,
    anchorAt: null,
    band: null,
    effectiveElevationRange: null,
    samples: [],
    run: null,
    notes: [],
    measured: { anchorPosition: null, elevationMin: null, elevationMax: null, azimuthMin: null, azimuthMax: null },
  };
  if (!resolved) return base;

  base.anchorAt = resolved.anchorAt;
  base.notes = resolved.notes;

  // 生效仰角区间 = 用户区间 ∩ 锚点自带仰角带（预览、可满足率、窗口判定三处同一份语义）。
  const userRange = interval.elevationRange as [number, number];
  const anchorRange = resolved.elevationRange as [number, number] | null;
  if (anchorRange) {
    const inter = intersectElevation(userRange, anchorRange);
    if (!inter) {
      base.effectiveElevationRange = userRange;
      const p = solarPosition(resolved.anchorAt, lat, lng);
      base.measured.anchorPosition = p;
      base.measured.elevationMin = p.elevationDeg;
      base.measured.elevationMax = p.elevationDeg;
      base.measured.azimuthMin = p.azimuthDeg;
      base.measured.azimuthMax = p.azimuthDeg;
      base.status = 'elevation_miss';
      return base;
    }
    base.effectiveElevationRange = inter;
  } else {
    base.effectiveElevationRange = userRange;
  }

  const [bandStart, bandEnd] = bandToRange(resolved, interval);
  base.band = { start: bandStart, end: bandEnd };

  const spanMin = Math.max(1, (bandEnd.getTime() - bandStart.getTime()) / 60000);
  const stepMin = Math.max(1, Math.ceil(spanMin / 300)); // 最多 300 个采样点
  const samples = sampleWindow(lat, lng, bandStart, bandEnd, stepMin).map((s) => ({
    ...s,
    ok:
      elevationInRange(s.elevationDeg, base.effectiveElevationRange!) &&
      azimuthIntervalMatches(s.azimuthDeg, interval),
  }));
  base.samples = samples;

  const anchorPosition: SolarPosition = solarPosition(resolved.anchorAt, lat, lng);
  base.measured = {
    anchorPosition,
    elevationMin: samples.length ? Math.min(...samples.map((s) => s.elevationDeg)) : anchorPosition.elevationDeg,
    elevationMax: samples.length ? Math.max(...samples.map((s) => s.elevationDeg)) : anchorPosition.elevationDeg,
    azimuthMin: samples.length ? Math.min(...samples.map((s) => s.azimuthDeg)) : anchorPosition.azimuthDeg,
    azimuthMax: samples.length ? Math.max(...samples.map((s) => s.azimuthDeg)) : anchorPosition.azimuthDeg,
  };

  const elevOkCount = samples.filter((s) => elevationInRange(s.elevationDeg, base.effectiveElevationRange!)).length;
  if (elevOkCount < 2) {
    base.status = 'elevation_miss';
    return base;
  }

  if (interval.azimuthRange) {
    const azOk = samples.filter((s) => azimuthIntervalMatches(s.azimuthDeg, interval));
    if (azOk.length < 2) {
      base.status = 'azimuth_miss';
      return base;
    }
  }

  const run = longestRun(samples);
  if (!run) {
    // 理论上 elev+az 都有点却连不成段：按方位角未命中处理（最保守且可复算）
    base.status = interval.azimuthRange ? 'azimuth_miss' : 'elevation_miss';
    return base;
  }
  base.run = run;
  base.status = 'ok';
  return base;
}

export interface DayEvaluation {
  date: string;
  events: SunEvents;
  outOfSeason: boolean;
  intervals: IntervalEvaluation[];
  /** 所有命中段中窗口最长的一段（逐日窗口落库取这一段） */
  best: IntervalEvaluation | null;
  satisfiable: boolean;
}

function isOutOfSeason(date: string, season: TimingDto['seasonWindow']): boolean {
  if (!season) return false;
  const month = Number(date.slice(5, 7));
  const { fromMonth, toMonth } = season;
  return fromMonth <= toMonth
    ? !(month >= fromMonth && month <= toMonth)
    : !(month >= fromMonth || month <= toMonth);
}

/**
 * 一天的完整天文求值。预览 / 可满足率 / computeDay 共用此入口。
 * @param sunEventsFn 注入太阳事件函数，便于测试；默认用 astro.sunEvents。
 */
export function evaluateDay(
  lat: number,
  lng: number,
  tz: string,
  dateKey: string,
  rawTiming: TimingDto,
  getEvents: (lat: number, lng: number, tz: string, date: string) => SunEvents,
): DayEvaluation {
  const timing = normalizeTiming(rawTiming);
  const events = getEvents(lat, lng, tz, dateKey);
  const outOfSeason = isOutOfSeason(dateKey, timing.seasonWindow);
  const intervals = (timing.intervals ?? []).map((iv, i) => evaluateInterval(i, iv, lat, lng, events));
  const okIntervals = intervals.filter((iv) => iv.status === 'ok' && iv.run);
  const best = okIntervals.sort(
    (a, b) =>
      (b.run!.end.getTime() - b.run!.start.getTime()) - (a.run!.end.getTime() - a.run!.start.getTime()),
  )[0] ?? null;
  return {
    date: dateKey,
    events,
    outOfSeason,
    intervals,
    best,
    satisfiable: !outOfSeason && best !== null,
  };
}

/** 工具：基于已归一化的 timing 构造 ±窗口容差区间（供外部需要 band 时使用）。 */
export function toleranceBand(anchorAt: Date, windowToleranceMin: number): { start: Date; end: Date } {
  const tol = Math.max(1, windowToleranceMin ?? 12);
  return { start: addMinutes(anchorAt, -tol), end: addMinutes(anchorAt, tol) };
}

/**
 * 某天该条件在「纯天文 + 季节」层面是否可能成立（不含天气）。
 * 与逐日窗口判定共用 evaluateDay，保证可满足率与窗口结论一致。
 */
export function theoreticalOkForDay(
  lat: number,
  lng: number,
  tz: string,
  dateKey: string,
  timing: TimingDto,
  getEvents: (lat: number, lng: number, tz: string, date: string) => SunEvents = sunEvents,
): boolean {
  return evaluateDay(lat, lng, tz, dateKey, timing, getEvents).satisfiable;
}

/** 一年中"该条件理论可成立"的天数（只看天文与季节，不含天气），见 12.5。 */
export function theoreticalDaysInYear(
  lat: number,
  lng: number,
  tz: string,
  timing: TimingDto,
  year: number,
  getEvents: (lat: number, lng: number, tz: string, date: string) => SunEvents = sunEvents,
): { date: string; ok: boolean }[] {
  const out: { date: string; ok: boolean }[] = [];
  const start = new Date(Date.UTC(year, 0, 1));
  for (let i = 0; i < 366; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getUTCFullYear() !== year) break;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
    out.push({ date: key, ok: theoreticalOkForDay(lat, lng, tz, key, timing, getEvents) });
  }
  return out;
}
