/**
 * 天文计算（自研，无三方依赖）—— 见文档第 12 章。
 *
 * 提供：太阳位置（仰角/方位角）、日出日落、黄金/蓝调时刻、夜间、时间锚解析、
 * 以及窗口内的逐点采样。所有角度单位为「度」，方位角以正北为 0、顺时针增加。
 */

import {
  addMinutes,
  formatLocal,
  localDayRangeUtc,
  parseLocalDateKey,
  zonedTimeToUtc,
  utcToZonedParts,
} from './time.js';
import type { WindowVerdict } from './enums.js';
import type { AzimuthArc, ClockInterval, TimingDto, WindowReasonDto } from './types.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 太阳上缘触地平线（含大气折射与太阳半径） */
export const HORIZON_DEG = -0.833;
export const GOLDEN_UPPER_DEG = 6;
export const GOLDEN_LOWER_DEG = -4;
export const BLUE_LOWER_DEG = -6;
export const NIGHT_DEG = -12;

export interface SolarPosition {
  elevationDeg: number;
  azimuthDeg: number;
  declinationDeg: number;
  hourAngleDeg: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** NOAA 简化太阳位置算法，精度足够支撑本项目的窗口判定（误差 < 0.02°）。 */
export function solarPosition(date: Date, lat: number, lng: number): SolarPosition {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;

  const meanLon = (280.46 + 0.9856474 * n) % 360;
  const meanAnom = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const declination = Math.asin(clamp(Math.sin(obliquity) * Math.sin(eclLon), -1, 1));

  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lst = gmst + lng;
  const hourAngle = ((((lst - rightAscension * RAD) % 360) + 540) % 360) - 180;

  const phi = lat * DEG;
  const sinAlt =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle * DEG);
  const elevation = Math.asin(clamp(sinAlt, -1, 1));
  const az = Math.atan2(
    Math.sin(hourAngle * DEG),
    Math.cos(hourAngle * DEG) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  );
  const azimuth = (((az * RAD + 180) % 360) + 360) % 360;

  return {
    elevationDeg: elevation * RAD,
    azimuthDeg: azimuth,
    declinationDeg: declination * RAD,
    hourAngleDeg: hourAngle,
  };
}

export function elevationAt(date: Date, lat: number, lng: number): number {
  return solarPosition(date, lat, lng).elevationDeg;
}

export function azimuthAt(date: Date, lat: number, lng: number): number {
  return solarPosition(date, lat, lng).azimuthDeg;
}

/** 太阳过中天（正午）的 UTC 时刻；用小时角迭代收敛。 */
export function solarNoonUtc(lat: number, lng: number, reference: Date): Date {
  let t = reference.getTime() + (12 - lng / 15) * 3600000;
  for (let i = 0; i < 5; i += 1) {
    const { hourAngleDeg } = solarPosition(new Date(t), lat, lng);
    t -= (hourAngleDeg / 15) * 3600000;
    if (Math.abs(hourAngleDeg) < 0.0005) break;
  }
  return new Date(t);
}

export interface Crossing {
  time: Date;
  /** true = 由下向上穿过阈值（上升） */
  rising: boolean;
}

/** 在 [from, to) 区间内找太阳仰角穿过 threshold 的时刻（先粗扫再二分）。 */
export function findElevationCrossings(
  lat: number,
  lng: number,
  from: Date,
  to: Date,
  thresholdDeg: number,
  stepMin = 4,
): Crossing[] {
  const out: Crossing[] = [];
  const step = stepMin * 60000;
  let prevT = from.getTime();
  let prevF = elevationAt(new Date(prevT), lat, lng) - thresholdDeg;

  for (let t = prevT + step; t <= to.getTime(); t += step) {
    const f = elevationAt(new Date(t), lat, lng) - thresholdDeg;
    if ((prevF < 0 && f >= 0) || (prevF > 0 && f <= 0)) {
      let lo = prevT;
      let hi = t;
      let fLo = prevF;
      for (let i = 0; i < 26; i += 1) {
        const mid = (lo + hi) / 2;
        const fMid = elevationAt(new Date(mid), lat, lng) - thresholdDeg;
        if ((fMid < 0 && fLo < 0) || (fMid > 0 && fLo > 0)) {
          lo = mid;
          fLo = fMid;
        } else {
          hi = mid;
        }
      }
      out.push({ time: new Date((lo + hi) / 2), rising: prevF < 0 });
    }
    prevT = t;
    prevF = f;
  }
  return out;
}

export interface SunEvents {
  date: string;
  tz: string;
  solarNoon: Date;
  maxElevationDeg: number;
  sunrise: Date | null;
  sunset: Date | null;
  goldenAm: { start: Date; end: Date } | null;
  goldenPm: { start: Date; end: Date } | null;
  blueAm: { start: Date; end: Date } | null;
  bluePm: { start: Date; end: Date } | null;
  nightStart: Date | null;
  nightEnd: Date | null;
  polar: 'none' | 'midnight_sun' | 'polar_night';
  notes: string[];
}

function pickCrossing(
  list: Crossing[],
  opts: { rising?: boolean; after?: Date; before?: Date } = {},
): Crossing | null {
  const filtered = list.filter((c) => {
    if (opts.rising !== undefined && c.rising !== opts.rising) return false;
    if (opts.after && c.time.getTime() < opts.after.getTime()) return false;
    if (opts.before && c.time.getTime() > opts.before.getTime()) return false;
    return true;
  });
  return filtered[0] ?? null;
}

/**
 * 计算某地某「本地日期」的全部太阳事件。
 * 扫描范围向两侧各外扩 3 小时，避免凌晨/深夜事件被日界切断。
 */
export function sunEvents(lat: number, lng: number, tz: string, localDate: string): SunEvents {
  const { year, month, day } = parseLocalDateKey(localDate);
  const dayRange = localDayRangeUtc(localDate, tz);
  const scanFrom = addMinutes(dayRange.start, -180);
  const scanTo = addMinutes(dayRange.end, 180);
  const notes: string[] = [];

  const noonRef = zonedTimeToUtc(tz, year, month, day, 12, 0);
  const solarNoon = solarNoonUtc(lat, lng, noonRef);
  const maxElevationDeg = elevationAt(solarNoon, lat, lng);

  const cHorizon = findElevationCrossings(lat, lng, scanFrom, scanTo, HORIZON_DEG);
  const cGoldenUp = findElevationCrossings(lat, lng, scanFrom, scanTo, GOLDEN_UPPER_DEG);
  const cGoldenLow = findElevationCrossings(lat, lng, scanFrom, scanTo, GOLDEN_LOWER_DEG);
  const cBlueLow = findElevationCrossings(lat, lng, scanFrom, scanTo, BLUE_LOWER_DEG);
  const cNight = findElevationCrossings(lat, lng, scanFrom, scanTo, NIGHT_DEG);

  const sunriseC = pickCrossing(cHorizon, { rising: true });
  const sunsetC = [...cHorizon].reverse().find((c) => !c.rising) ?? null;

  const polar: SunEvents['polar'] =
    maxElevationDeg < HORIZON_DEG ? 'polar_night' : sunriseC && sunsetC ? 'none' : 'midnight_sun';

  if (polar === 'midnight_sun') notes.push('该日太阳未落（极昼），无日出/日落锚点');
  if (polar === 'polar_night') notes.push('该日太阳未升（极夜），无日出/日落锚点');

  const goldenAmStart = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -120), addMinutes(sunriseC.time, 240), GOLDEN_LOWER_DEG).find((c) => c.rising)
    : pickCrossing(cGoldenLow, { rising: true });
  const goldenAmEnd = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -120), addMinutes(sunriseC.time, 300), GOLDEN_UPPER_DEG).find((c) => c.rising)
    : pickCrossing(cGoldenUp, { rising: true });

  const goldenPmStart = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -300), addMinutes(sunsetC.time, 120), GOLDEN_UPPER_DEG)].reverse().find((c) => !c.rising)
    : null;
  const goldenPmEnd = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -240), addMinutes(sunsetC.time, 120), GOLDEN_LOWER_DEG)].reverse().find((c) => !c.rising)
    : null;

  const blueAmStart = sunriseC
    ? findElevationCrossings(lat, lng, addMinutes(sunriseC.time, -180), addMinutes(sunriseC.time, 180), BLUE_LOWER_DEG).find((c) => c.rising)
    : null;
  const bluePmEnd = sunsetC
    ? [...findElevationCrossings(lat, lng, addMinutes(sunsetC.time, -180), addMinutes(sunsetC.time, 180), BLUE_LOWER_DEG)].reverse().find((c) => !c.rising)
    : null;

  const nightStart = sunsetC
    ? [...cNight].reverse().find((c) => !c.rising && c.time.getTime() >= sunsetC.time.getTime() - 3600000) ?? null
    : null;
  const nightEnd = sunriseC
    ? cNight.find((c) => c.rising && c.time.getTime() >= sunriseC.time.getTime() - 3600000) ?? null
    : null;

  const band = (a: Crossing | null | undefined, b: Crossing | null | undefined) =>
    a && b && b.time.getTime() > a.time.getTime() ? { start: a.time, end: b.time } : null;

  return {
    date: localDate,
    tz,
    solarNoon,
    maxElevationDeg,
    sunrise: sunriseC?.time ?? null,
    sunset: sunsetC?.time ?? null,
    goldenAm: band(goldenAmStart, goldenAmEnd),
    goldenPm: band(goldenPmStart, goldenPmEnd),
    blueAm: band(blueAmStart, goldenAmStart),
    bluePm: band(goldenPmEnd, bluePmEnd),
    nightStart: nightStart?.time ?? null,
    nightEnd: nightEnd?.time ?? null,
    polar,
    notes,
  };
}

export interface AnchorResolution {
  anchorAt: Date;
  /** 锚点自带的仰角区间；无则为 null */
  elevationRange: [number, number] | null;
  /** 锚点自带的时间范围（黄金/蓝调/夜间）；无则为 null */
  band: { start: Date; end: Date } | null;
  notes: string[];
}

/**
 * 把时间锚解析成绝对时刻（见文档 12.2）。
 * 返回 null 表示该日期/纬度下锚点无解（极昼极夜、日出前偏移越界等）。
 */
export function resolveAnchor(
  events: SunEvents,
  timing: Pick<TimingDto, 'timeAnchor' | 'anchorOffsetMin'>,
): AnchorResolution | null {
  const notes: string[] = [];
  const { timeAnchor, anchorOffsetMin } = timing;

  const needSun = (base: Date | null): Date | null => {
    if (!base) notes.push('该日无日出/日落事件，锚点无解');
    return base;
  };

  switch (timeAnchor) {
    case 'sunrise': {
      const base = needSun(events.sunrise);
      return base ? { anchorAt: base, elevationRange: null, band: null, notes } : null;
    }
    case 'sunset': {
      const base = needSun(events.sunset);
      return base ? { anchorAt: base, elevationRange: null, band: null, notes } : null;
    }
    case 'sunrise_plus': {
      const base = needSun(events.sunrise);
      return base
        ? { anchorAt: addMinutes(base, anchorOffsetMin), elevationRange: null, band: null, notes }
        : null;
    }
    case 'sunset_minus': {
      const base = needSun(events.sunset);
      return base
        ? { anchorAt: addMinutes(base, -Math.abs(anchorOffsetMin)), elevationRange: null, band: null, notes }
        : null;
    }
    case 'golden_am': {
      if (!events.goldenAm) {
        notes.push('该日无黄金时刻（晨）');
        return null;
      }
      return {
        anchorAt: events.goldenAm.start,
        elevationRange: [GOLDEN_LOWER_DEG, GOLDEN_UPPER_DEG],
        band: events.goldenAm,
        notes,
      };
    }
    case 'golden_pm': {
      if (!events.goldenPm) {
        notes.push('该日无黄金时刻（昏）');
        return null;
      }
      return {
        anchorAt: events.goldenPm.end,
        elevationRange: [GOLDEN_LOWER_DEG, GOLDEN_UPPER_DEG],
        band: events.goldenPm,
        notes,
      };
    }
    case 'blue_am': {
      if (!events.blueAm) {
        notes.push('该日无蓝调时刻（晨）');
        return null;
      }
      return {
        anchorAt: events.blueAm.start,
        elevationRange: [BLUE_LOWER_DEG, GOLDEN_LOWER_DEG],
        band: events.blueAm,
        notes,
      };
    }
    case 'blue_pm': {
      if (!events.bluePm) {
        notes.push('该日无蓝调时刻（昏）');
        return null;
      }
      return {
        anchorAt: events.bluePm.end,
        elevationRange: [BLUE_LOWER_DEG, GOLDEN_LOWER_DEG],
        band: events.bluePm,
        notes,
      };
    }
    case 'solar_noon': {
      return { anchorAt: events.solarNoon, elevationRange: null, band: null, notes };
    }
    case 'night': {
      if (!events.nightStart) {
        notes.push('该日无夜间时段（极昼）');
        return null;
      }
      const end = events.nightEnd ?? addMinutes(events.nightStart, 240);
      const capped = end.getTime() - events.nightStart.getTime() > 240 * 60000;
      if (capped) notes.push('夜间窗口过长，已截取前 240 分钟');
      return {
        anchorAt: events.nightStart,
        elevationRange: [-90, NIGHT_DEG],
        band: { start: events.nightStart, end: capped ? addMinutes(events.nightStart, 240) : end },
        notes,
      };
    }
    case 'fixed_clock': {
      const p = utcToZonedParts(events.solarNoon, events.tz);
      const hour = Math.floor(anchorOffsetMin / 60);
      const minute = Math.round(anchorOffsetMin % 60);
      const at = zonedTimeToUtc(events.tz, p.year, p.month, p.day, hour, minute);
      return { anchorAt: at, elevationRange: null, band: null, notes };
    }
    default:
      return null;
  }
}

export interface WindowSample {
  at: Date;
  elevationDeg: number;
  azimuthDeg: number;
}

/** 对时间区间做等距采样，供方位角约束求交与理由输出使用。 */
export function sampleWindow(
  lat: number,
  lng: number,
  start: Date,
  end: Date,
  stepMin = 2,
): WindowSample[] {
  const out: WindowSample[] = [];
  const step = stepMin * 60000;
  for (let t = start.getTime(); t <= end.getTime(); t += step) {
    const d = new Date(t);
    const p = solarPosition(d, lat, lng);
    out.push({ at: d, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg });
  }
  const last = new Date(end.getTime());
  if (out.length === 0 || out[out.length - 1].at.getTime() !== last.getTime()) {
    const p = solarPosition(last, lat, lng);
    out.push({ at: last, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg });
  }
  return out;
}

/** 一年中"该条件理论可成立"的天数（只看天文与季节，不含天气），见 12.5。 */
export function theoreticalDaysInYear(
  lat: number,
  lng: number,
  tz: string,
  timing: TimingDto,
  year: number,
): { date: string; ok: boolean }[] {
  const out: { date: string; ok: boolean }[] = [];
  const start = new Date(Date.UTC(year, 0, 1));
  for (let i = 0; i < 366; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getUTCFullYear() !== year) break;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
    out.push({ date: key, ok: theoreticalOkForDay(lat, lng, tz, key, timing) });
  }
  return out;
}

export function theoreticalOkForDay(
  lat: number,
  lng: number,
  tz: string,
  date: string,
  timing: TimingDto,
): boolean {
  return evaluateAstronomy(lat, lng, tz, date, timing).verdict !== 'bad';
}

export function elevationInRange(elevationDeg: number, range: number[]): boolean {
  if (!Array.isArray(range) || range.length !== 2) return true;
  return elevationDeg >= range[0] - 0.05 && elevationDeg <= range[1] + 0.05;
}

export function angularDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** 归一化到 [0, 360)（360 本身视作 0） */
export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * 判断方位角是否落在「从 startDeg 顺时针走到 endDeg」的圆弧内（边界含）。
 * endDeg <= startDeg 表示跨过 0°/360°（例：350→10）；endDeg 允许为 360（上界，等价 0°）。
 * 零宽弧（起终点等价）不含任何方向——无效输入在 validateTiming 处已拒绝。
 */
export function azimuthArcContains(valueDeg: number, arc: AzimuthArc): boolean {
  const { startDeg, endDeg } = arc;
  // 整圈（中心±180 会生成这种弧；直接输入 [0,360] 在 validateTiming 处被拒绝）
  if (startDeg === 0 && endDeg === 360) return true;
  const start = startDeg; // 0..360
  const end = endDeg === 360 ? 0 : endDeg; // 结束于 360 ≡ 正北 0°，但仍与开始在同一弧内
  const v = normalizeAzimuth(valueDeg);
  if (start === end) return false; // 零宽弧不含任何方向
  if (start < end) return v >= start && v <= end;
  // 跨正北：[start, 360) ∪ [0, end]；end=360 归一为 0，正北仍由 v<=0 包含
  return v >= start || v <= end;
}

const ARC_EDGE_EPS = 0.001;

/**
 * 把全部方位角约束展开成一组顺时针圆弧：
 * - 旧字段 azimuthRange（方位角中心 ± 容差）→ 以中心为中点的圆弧；
 * - 新字段 azimuthArcs → 原样使用，端点各外扩 0.001° 抵消采样误差（外扩时保持环绕方向，
 *   不能把 [0,90] 这种贴边普通弧错误翻成跨正北弧）。
 */
export function effectiveAzimuthArcs(timing: TimingDto): AzimuthArc[] {
  if (timing.azimuthRange) {
    const [azLo, azHi] = timing.azimuthRange;
    const center = (azLo + azHi) / 2;
    const tol = Math.min(180, timing.azimuthTolerance);
    if (tol >= 180) return [{ startDeg: 0, endDeg: 360 }];
    return [{ startDeg: normalizeAzimuth(center - tol), endDeg: normalizeAzimuth(center + tol) }];
  }
  return timing.azimuthArcs.map((a) => {
    const wraps = a.endDeg <= a.startDeg;
    if (wraps) {
      return {
        startDeg: (a.startDeg - ARC_EDGE_EPS + 360) % 360,
        endDeg: (a.endDeg + ARC_EDGE_EPS) % 360,
      };
    }
    return {
      startDeg: Math.max(0, a.startDeg - ARC_EDGE_EPS),
      endDeg: Math.min(360, a.endDeg + ARC_EDGE_EPS),
    };
  });
}

/** 把锚点解析结果变成用于判定的 [start, end] 区间 */
export function bandToRange(
  resolved: AnchorResolution,
  timing: Pick<TimingDto, 'windowToleranceMin'>,
): [Date, Date] {
  if (resolved.band) return [resolved.band.start, resolved.band.end];
  const tol = Math.max(1, timing.windowToleranceMin ?? 12);
  return [addMinutes(resolved.anchorAt, -tol), addMinutes(resolved.anchorAt, tol)];
}

// ---------------------------------------------------------------------------
// 多段允许区间（机位本地钟点，可跨午夜）+ 统一天文评估器
// ---------------------------------------------------------------------------

/**
 * 把一段机位时区本地钟点区间落到某一本地日期对应的 UTC 绝对区间。
 * endMin <= startMin → 结束在次日（跨午夜）；endMin = 1440 = 次日 00:00。
 */
export function clockIntervalToUtc(dateKey: string, tz: string, iv: ClockInterval): { start: Date; end: Date } {
  const { year, month, day } = parseLocalDateKey(dateKey);
  const startH = Math.floor(iv.startMin / 60);
  const startM = iv.startMin % 60;
  const spansMidnight = iv.endMin <= iv.startMin;
  const endDay = day + (spansMidnight ? 1 : 0);
  const endH = Math.floor(iv.endMin / 60) % 24;
  const endM = iv.endMin % 60;
  return {
    start: zonedTimeToUtc(tz, year, month, day, startH, startM),
    end: zonedTimeToUtc(tz, year, month, endDay, endH, endM),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDeg(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '未知' : `${v.toFixed(digits)}°`;
}

/** 23:00–01:00 这种跨午夜区间的可复算标签 */
export function formatClockInterval(iv: ClockInterval): string {
  const hm = (m: number) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
  const wrap = iv.endMin <= iv.startMin;
  return `${hm(iv.startMin)}–${hm(iv.endMin)}${wrap ? '（次日）' : ''}`;
}

export interface AstronomySegment {
  label: string;
  startAt: Date;
  endAt: Date;
  /** 该段选出的最佳连续窗口 */
  run: { start: Date; end: Date } | null;
  /** 该段贡献的判定理由（bad 段也带自己的原因，便于逐段复算） */
  reasons: WindowReasonDto[];
  /** true = 该段天文条件不成立（不会参与窗口选择） */
  rejected: boolean;
  /** 被拒原因的级别汇总，用于可满足率统计 */
  failureCode: string | null;
  /** 窗口中点的太阳位置 */
  midPosition: SolarPosition | null;
  durationMin: number;
  /** 命中采样点的实际仰角/方位范围 */
  observed: { elevMin: number; elevMax: number; azMin: number; azMax: number } | null;
}

export interface AstronomyEvaluation {
  date: string;
  anchorAt: Date;
  polar: SunEvents['polar'];
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  segments: AstronomySegment[];
  /** 多段中时长最长的可用段；全部不成立时为 null */
  bestSegment: AstronomySegment | null;
  sunElevation: number | null;
  sunAzimuth: number | null;
  outOfSeason: boolean;
}

/** 采样点间隔至少 1 分钟、单段最多 300 点 */
function sampleStepMin(start: Date, end: Date): number {
  const spanMin = Math.max(1, (end.getTime() - start.getTime()) / 60000);
  return Math.max(1, Math.ceil(spanMin / 300));
}

/** 找连续（间断 ≤ 6 分钟）满足采样点中最长的一段 */
export function longestContiguousRun(
  samples: { at: Date; ok: boolean }[],
  gapMin = 6,
): { start: Date; end: Date } | null {
  let best: { start: Date; end: Date } | null = null;
  let runStart: Date | null = null;
  let prevAt: Date | null = null;

  const consider = (start: Date, end: Date) => {
    if (!best || end.getTime() - start.getTime() > best.end.getTime() - best.start.getTime()) {
      best = { start, end };
    }
  };

  for (const s of samples) {
    if (s.ok) {
      if (!runStart) {
        runStart = s.at;
      } else if (prevAt && (s.at.getTime() - prevAt.getTime()) / 60000 > gapMin) {
        consider(runStart, prevAt);
        runStart = s.at;
      }
      prevAt = s.at;
    } else if (runStart && prevAt) {
      consider(runStart, prevAt);
      runStart = null;
      prevAt = null;
    }
  }
  if (runStart && prevAt) consider(runStart, prevAt);
  return best;
}

function outOfSeasonReason(timing: TimingDto, month: number): WindowReasonDto {
  const { fromMonth, toMonth } = timing.seasonWindow!;
  return {
    code: 'OUT_OF_SEASON',
    level: 'bad',
    text: `${month} 月不在设定季节窗口（${fromMonth}–${toMonth} 月）内`,
  };
}

function isSeasonMonth(timing: TimingDto, month: number): boolean {
  if (!timing.seasonWindow) return true;
  const { fromMonth, toMonth } = timing.seasonWindow;
  return fromMonth <= toMonth ? month >= fromMonth && month <= toMonth : month >= fromMonth || month <= toMonth;
}

/**
 * 单日天文条件统一评估器——预览、可满足率、窗口判定**共用这一份代码**，
 * 保证跨午夜多段区间与极区（极昼/极夜）在三处得到完全一致的结论。
 * 只看天文与季节，不含天气。
 */
export function evaluateAstronomy(
  lat: number,
  lng: number,
  tz: string,
  dateKey: string,
  timing: TimingDto,
): AstronomyEvaluation {
  const { month } = parseLocalDateKey(dateKey);
  const events = sunEvents(lat, lng, tz, dateKey);
  const reasons: WindowReasonDto[] = [];
  events.notes.forEach((n) => reasons.push({ code: 'SUN_EVENT_NOTE', level: 'info', text: n }));

  const failAll = (
    extra: WindowReasonDto[],
    anchorAt: Date = events.solarNoon,
  ): AstronomyEvaluation => ({
    date: dateKey,
    anchorAt,
    polar: events.polar,
    verdict: 'bad',
    reasons: [...reasons, ...extra],
    segments: [],
    bestSegment: null,
    sunElevation: null,
    sunAzimuth: null,
    outOfSeason: extra.some((r) => r.code === 'OUT_OF_SEASON'),
  });

  if (!isSeasonMonth(timing, month)) {
    return failAll([outOfSeasonReason(timing, month)]);
  }

  const resolved = resolveAnchor(events, timing);
  if (!resolved) {
    return failAll([
      {
        code: 'ANCHOR_UNRESOLVABLE',
        level: 'bad',
        text: '该日无法解析时间锚点（可能是极昼/极夜或偏移越界）',
      },
    ]);
  }

  resolved.notes.forEach((n) => reasons.push({ code: 'ANCHOR_NOTE', level: 'info', text: n }));
  reasons.push({
    code: 'ANCHOR_RESOLVED',
    level: 'ok',
    text: `${describeAnchor(timing)} → ${formatLocal(resolved.anchorAt, tz)}`,
  });

  const effectiveElevation = resolved.elevationRange ?? timing.elevationRange;
  if (resolved.elevationRange) {
    reasons.push({
      code: 'ELEVATION_TARGET',
      level: 'info',
      text: `该锚点自带仰角区间 ${resolved.elevationRange[0]}°–${resolved.elevationRange[1]}°`,
    });
  }

  const multi = timing.allowedIntervals.length > 0;
  const arcs = effectiveAzimuthArcs(timing);
  const multiLabel = timing.allowedIntervals.map(formatClockInterval);
  const segments: AstronomySegment[] = [];

  const rawRanges: { label: string; start: Date; end: Date }[] = multi
    ? timing.allowedIntervals.map((iv, i) => ({
        label: `区间 ${i + 1}（${multiLabel[i]}）`,
        ...clockIntervalToUtc(dateKey, tz, iv),
      }))
    : [{ label: '', start: bandToRange(resolved, timing)[0], end: bandToRange(resolved, timing)[1] }];

  rawRanges.forEach((range) => {
    const segReasons: WindowReasonDto[] = [];
    const stepMin = sampleStepMin(range.start, range.end);
    const samples = sampleWindow(lat, lng, range.start, range.end, stepMin);
    const prefix = multi ? `${range.label}：` : '';
    // 单段（旧）路径在锚点处取实测值，与历史判定理由逐字一致；多段时锚点可能落在区间外，改用区间中点
    const probeAt = multi ? new Date((range.start.getTime() + range.end.getTime()) / 2) : resolved.anchorAt;
    const fmtElev = (v: number) => (multi ? `${v.toFixed(1)}°` : fmtDeg(v));

    const reject = (r: WindowReasonDto, code: string, mid: SolarPosition | null = null): AstronomySegment => ({
      label: range.label,
      startAt: range.start,
      endAt: range.end,
      run: null,
      reasons: [r],
      rejected: true,
      failureCode: code,
      midPosition: mid,
      durationMin: 0,
      observed: null,
    });

    const elevOk = samples.filter((s) => elevationInRange(s.elevationDeg, effectiveElevation));
    if (elevOk.length < 2) {
      const mid = solarPosition(probeAt, lat, lng);
      segments.push(
        reject(
          {
            code: 'ELEVATION_MISS',
            level: 'bad',
            text: `${prefix}窗口内太阳仰角始终不在 ${effectiveElevation[0]}°–${effectiveElevation[1]}°（${multi ? '时段中点' : '锚点处'}实测 ${fmtElev(mid.elevationDeg)}）`,
          },
          'ELEVATION_MISS',
          mid,
        ),
      );
      return;
    }
    segReasons.push({
      code: 'ELEVATION_OK',
      level: 'ok',
      text: `${prefix}窗口内仰角 ${fmtDeg(Math.min(...elevOk.map((s) => s.elevationDeg)))}–${fmtDeg(
        Math.max(...elevOk.map((s) => s.elevationDeg)),
      )}（目标 ${effectiveElevation[0]}°–${effectiveElevation[1]}°）`,
    });

    const candidateSamples = samples.map((s) => ({
      ...s,
      ok:
        elevationInRange(s.elevationDeg, effectiveElevation) &&
        (arcs.length === 0 || arcs.some((a) => azimuthArcContains(s.azimuthDeg, a))),
    }));
    const hit = candidateSamples.filter((s) => s.ok);
    if (arcs.length > 0 && hit.length < 2) {
      const mid = solarPosition(probeAt, lat, lng);
      segments.push(
        reject(
          {
            code: 'AZIMUTH_MISS',
            level: 'bad',
            text: `${prefix}太阳方位角始终不在 ${describeArcs(timing)}（${multi ? '时段中点' : '锚点处'}实测 ${fmtDeg(mid.azimuthDeg, 0)}）`,
          },
          'AZIMUTH_MISS',
          mid,
        ),
      );
      return;
    }
    if (arcs.length > 0) {
      segReasons.push({
        code: 'AZIMUTH_OK',
        level: 'ok',
        text: `${prefix}方位角命中 ${describeArcs(timing)}（${multi ? '实测' : '窗口内实测'} ${fmtDeg(
          Math.min(...hit.map((s) => s.azimuthDeg)),
          0,
        )}–${fmtDeg(Math.max(...hit.map((s) => s.azimuthDeg)), 0)}）`,
      });
    }

    const run = longestContiguousRun(candidateSamples);
    if (!run) {
      segments.push(
        reject(
          { code: 'WINDOW_EMPTY', level: 'bad', text: `${prefix}没有满足全部天文约束的时刻` },
          'WINDOW_EMPTY',
        ),
      );
      return;
    }

    const durationMin = (run.end.getTime() - run.start.getTime()) / 60000 + stepMin;
    if (durationMin < 5) {
      segReasons.push({
        code: 'WINDOW_TOO_SHORT',
        level: 'warn',
        text: `${prefix}可用窗口仅约 ${durationMin.toFixed(0)} 分钟（少于 5 分钟）`,
      });
    }
    segReasons.push({
      code: 'WINDOW_RANGE',
      level: 'ok',
      text: `${prefix}窗口 ${formatLocal(run.start, tz)}–${formatLocal(run.end, tz)}（约 ${durationMin.toFixed(0)} 分钟）`,
    });

    segments.push({
      label: range.label,
      startAt: range.start,
      endAt: range.end,
      run,
      reasons: segReasons,
      rejected: false,
      failureCode: null,
      midPosition: solarPosition(new Date((run.start.getTime() + run.end.getTime()) / 2), lat, lng),
      durationMin,
      observed: {
        elevMin: Math.min(...hit.map((s) => s.elevationDeg)),
        elevMax: Math.max(...hit.map((s) => s.elevationDeg)),
        azMin: Math.min(...hit.map((s) => s.azimuthDeg)),
        azMax: Math.max(...hit.map((s) => s.azimuthDeg)),
      },
    });
  });

  const usable = segments.filter((s) => !s.rejected && s.run);
  if (usable.length === 0) {
    return {
      date: dateKey,
      anchorAt: resolved.anchorAt,
      polar: events.polar,
      verdict: 'bad',
      reasons: [...reasons, ...segments.flatMap((s) => s.reasons)],
      segments,
      bestSegment: null,
      sunElevation: segments[0]?.midPosition?.elevationDeg ?? null,
      sunAzimuth: segments[0]?.midPosition?.azimuthDeg ?? null,
      outOfSeason: false,
    };
  }

  // 多段各自独立，挑最长的一段作为当日窗口
  const best = usable.reduce((a, b) => (b.durationMin > a.durationMin ? b : a));
  const verdict: AstronomyEvaluation['verdict'] = best.durationMin < 5 ? 'marginal' : 'good';

  if (multi) {
    reasons.push({
      code: 'INTERVALS_PLAN',
      level: 'info',
      text: `当天按 ${timing.allowedIntervals.length} 段允许钟点判定：${multiLabel.join('、')}（机位时区 ${tz}）`,
    });
    segments.forEach((s) => {
      if (s.rejected) {
        reasons.push({
          code: 'WINDOW_SEGMENT_SKIP',
          level: 'info',
          text: `${s.label}不成立，已跳过（${s.failureCode === 'ELEVATION_MISS' ? '仰角不符' : s.failureCode === 'AZIMUTH_MISS' ? '方位不符' : '无满足时刻'}）`,
        });
      }
    });
  }

  return {
    date: dateKey,
    anchorAt: resolved.anchorAt,
    polar: events.polar,
    verdict,
    reasons: [...reasons, ...segments.flatMap((s) => s.reasons)],
    segments,
    bestSegment: best,
    sunElevation: best.midPosition!.elevationDeg,
    sunAzimuth: best.midPosition!.azimuthDeg,
    outOfSeason: false,
  };
}

function describeArcs(timing: TimingDto): string {
  if (timing.azimuthRange) {
    const [azLo, azHi] = timing.azimuthRange;
    return `${((azLo + azHi) / 2).toFixed(0)}°±${timing.azimuthTolerance}°`;
  }
  return timing.azimuthArcs
    .map((a) => `${a.startDeg.toFixed(0)}°→${a.endDeg.toFixed(0)}°`)
    .join(' 或 ');
}

function describeAnchor(timing: Pick<TimingDto, 'timeAnchor' | 'anchorOffsetMin'>): string {
  switch (timing.timeAnchor) {
    case 'sunrise_plus':
      return `日出后 ${timing.anchorOffsetMin} 分`;
    case 'sunset_minus':
      return `日落前 ${Math.abs(timing.anchorOffsetMin)} 分`;
    case 'fixed_clock':
      return `固定钟点 ${String(Math.floor(timing.anchorOffsetMin / 60)).padStart(2, '0')}:${String(
        Math.round(timing.anchorOffsetMin % 60),
      ).padStart(2, '0')}`;
    default:
      return timing.timeAnchor;
  }
}
