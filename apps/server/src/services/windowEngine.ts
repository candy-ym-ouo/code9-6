import {
  addDaysToKey,
  addMinutes,
  describeIntervalAnchor,
  evaluateDay,
  formatLocal,
  localDateKey,
  normalizeTiming,
  sunEvents,
  type DayEvaluation,
  type IntervalEvaluation,
  type ReproWindowDto,
  type TimingDto,
  type WeatherPhenomenon,
  type WindowReasonDto,
  type WindowVerdict,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { config } from '../config.js';
import { emitEvent } from './events.js';
import {
  getForecast,
  phenomenonHolds,
  summarizeEpisode,
  type EpisodeWeather,
} from './weather.js';

export interface TimingRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  time_anchor: TimingDto['timeAnchor'];
  anchor_offset_min: number;
  elevation_range: string;
  azimuth_range: string | null;
  azimuth_tolerance: number;
  window_tolerance_min: number;
  weather_profile: string;
  season_window: string | null;
  intervals: string | null;
  repeat_rule: string | null;
  notes: string | null;
}

export interface SpotGeom {
  id: string;
  lat: number;
  lng: number;
  camera_bearing: number;
  tz: string;
}

/** 读出的 timing 行统一归一化：旧行没有 intervals 时由顶层字段合成唯一段。 */
export function timingRowToDto(row: TimingRow): TimingDto {
  const dto: TimingDto = {
    timeAnchor: row.time_anchor,
    anchorOffsetMin: row.anchor_offset_min,
    elevationRange: parseJson<number[]>(row.elevation_range, [-90, 90]),
    azimuthRange: row.azimuth_range ? parseJson<number[] | null>(row.azimuth_range, null) : null,
    azimuthTolerance: row.azimuth_tolerance,
    windowToleranceMin: row.window_tolerance_min,
    weatherProfile: parseJson(row.weather_profile, {}),
    seasonWindow: row.season_window
      ? parseJson<{ fromMonth: number; toMonth: number } | null>(row.season_window, null)
      : null,
    notes: row.notes,
  };
  if (row.intervals) {
    const intervals = parseJson<TimingDto['intervals']>(row.intervals, undefined);
    if (Array.isArray(intervals) && intervals.length > 0) dto.intervals = intervals;
  }
  return normalizeTiming(dto);
}

export function loadTiming(inspirationId: string): TimingRow | null {
  return (
    (getDb().prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(inspirationId) as TimingRow | undefined) ??
    null
  );
}

/**
 * 统一的 timing 落库入口：应用 DTO 级补丁后同时写顶层旧字段与多段 JSON，
 * 保证校准（calibration）等只改某一个字段的调用方不会让顶层/多段出现两份不一致的值。
 */
export function patchTimingRecord(
  inspirationId: string,
  patch: Partial<TimingDto>,
  ts = nowIso(),
): TimingDto | null {
  const existing = loadTiming(inspirationId);
  if (!existing) return null;
  const next = normalizeTiming({ ...timingRowToDto(existing), ...patch });
  getDb()
    .prepare(
      `UPDATE timing SET time_anchor=?, anchor_offset_min=?, elevation_range=?, azimuth_range=?,
         azimuth_tolerance=?, window_tolerance_min=?, weather_profile=?, season_window=?,
         intervals=?, notes=?, updated_at=? WHERE id=?`,
    )
    .run(
      next.timeAnchor,
      next.anchorOffsetMin,
      toJson(next.elevationRange),
      next.azimuthRange ? toJson(next.azimuthRange) : null,
      next.azimuthTolerance,
      next.windowToleranceMin,
      toJson(next.weatherProfile),
      next.seasonWindow ? toJson(next.seasonWindow) : null,
      toJson(next.intervals ?? []),
      next.notes,
      ts,
      existing.id,
    );
  return next;
}

export function loadSpotGeom(spotId: string): SpotGeom | null {
  const row = getDb()
    .prepare('SELECT id, lat, lng, camera_bearing, tz FROM spot WHERE id = ?')
    .get(spotId) as SpotGeom | undefined;
  return row ?? null;
}

interface DayResult {
  date: string;
  startAt: Date;
  endAt: Date;
  anchorAt: Date;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  episode: EpisodeWeather | null;
}

function fmtDeg(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '未知' : `${v.toFixed(digits)}°`;
}

function intervalLabel(ev: IntervalEvaluation): string {
  const n = ev.interval.label?.trim();
  const base = describeIntervalAnchor(ev.interval);
  return n ? `第 ${ev.index + 1} 段「${n}」（${base}）` : `第 ${ev.index + 1} 段（${base}）`;
}

/** 把共享层的结构化单段求值转成中文理由；ok 段返回 null 以外的统计理由。 */
function intervalReasons(ev: IntervalEvaluation, tz: string): WindowReasonDto[] {
  const out: WindowReasonDto[] = [];
  const label = intervalLabel(ev);
  const iv = ev.interval;

  if (ev.status === 'anchor_unresolved') {
    out.push({
      code: 'ANCHOR_UNRESOLVABLE',
      level: 'bad',
      text: `${label}：该日无法解析时间锚点（极昼/极夜或该日无此太阳事件）`,
    });
    ev.notes.forEach((n) =>
      out.push({ code: 'ANCHOR_NOTE', level: 'info', text: `${label}：${n}` }),
    );
    return out;
  }

  out.push({
    code: 'ANCHOR_RESOLVED',
    level: 'ok',
    text: `${label} → ${formatLocal(ev.anchorAt!, tz)}`,
  });
  ev.notes.forEach((n) => out.push({ code: 'ANCHOR_NOTE', level: 'info', text: `${label}：${n}` }));
  if (ev.resolved?.elevationRange) {
    out.push({
      code: 'ELEVATION_TARGET',
      level: 'info',
      text: `${label}：该锚点自带仰角区间 ${ev.resolved.elevationRange[0]}°–${ev.resolved.elevationRange[1]}°`,
    });
  }

  const [lo, hi] = ev.effectiveElevationRange ?? [-90, 90];
  if (ev.status === 'elevation_miss') {
    const anchorBand = ev.resolved?.elevationRange;
    if (anchorBand) {
      const userRange = ev.interval.elevationRange;
      const noOverlap =
        Math.max(userRange[0], anchorBand[0]) > Math.min(userRange[1], anchorBand[1]) + 1e-9;
      if (noOverlap) {
        out.push({
          code: 'ELEVATION_MISS',
          level: 'bad',
          text: `${label}：仰角区间 ${userRange[0]}°–${userRange[1]}° 与该锚点自带仰角带 ${anchorBand[0]}°–${anchorBand[1]}° 无交集，该日不可能同时成立`,
        });
        return out;
      }
    }
    out.push({
      code: 'ELEVATION_MISS',
      level: 'bad',
      text: `${label}：窗口内太阳仰角始终不在 ${lo}°–${hi}°（实测 ${fmtDeg(ev.measured.elevationMin)}–${fmtDeg(
        ev.measured.elevationMax,
      )}）`,
    });
    return out;
  }

  if (ev.status === 'azimuth_miss') {
    const [from, to] = iv.azimuthRange!;
    out.push({
      code: 'AZIMUTH_MISS',
      level: 'bad',
      text: `${label}：太阳方位角始终不在 ${from.toFixed(0)}° 顺时针到 ${to.toFixed(0)}° ±${
        iv.azimuthTolerance
      }° 弧内（锚点处实测 ${fmtDeg(ev.measured.anchorPosition?.azimuthDeg)}）`,
    });
    return out;
  }

  // status === 'ok'
  out.push({
    code: 'ELEVATION_OK',
    level: 'ok',
    text: `${label}：仰角 ${fmtDeg(ev.measured.elevationMin)}–${fmtDeg(ev.measured.elevationMax)}（目标 ${lo}°–${hi}°）`,
  });
  if (iv.azimuthRange) {
    const [from, to] = iv.azimuthRange;
    out.push({
      code: 'AZIMUTH_OK',
      level: 'ok',
      text: `${label}：方位角命中 ${from.toFixed(0)}°→${to.toFixed(0)}° ±${iv.azimuthTolerance}° 弧`,
    });
  }
  return out;
}

/** 判定单日窗口（文档 12.4 的算法，逐项产出 reasons）。天文部分全部委托共享层 evaluateDay。 */
export function computeDay(
  spot: SpotGeom,
  rawTiming: TimingDto,
  dateKey: string,
  forecast: Awaited<ReturnType<typeof getForecast>>,
): DayResult {
  const timing = normalizeTiming(rawTiming);
  const tz = spot.tz;
  const day: DayEvaluation = evaluateDay(spot.lat, spot.lng, tz, dateKey, timing, sunEvents);
  const reasons: WindowReasonDto[] = [];
  day.events.notes.forEach((n) => reasons.push({ code: 'SUN_EVENT_NOTE', level: 'info', text: n }));

  // ---- 季节窗口 ----
  if (day.outOfSeason) {
    const month = Number(dateKey.slice(5, 7));
    const { fromMonth, toMonth } = timing.seasonWindow!;
    reasons.push({
      code: 'OUT_OF_SEASON',
      level: 'bad',
      text: `${month} 月不在设定季节窗口（${fromMonth}–${toMonth} 月）内`,
    });
    return {
      date: dateKey,
      startAt: day.events.solarNoon,
      endAt: day.events.solarNoon,
      anchorAt: day.events.solarNoon,
      sunElevation: null,
      sunAzimuth: null,
      verdict: 'bad',
      reasons,
      episode: null,
    };
  }

  const multi = day.intervals.length > 1;

  // ---- 多段：先给出每段的天文结论（预览/可满足率看到的也是这同一份结论）----
  if (multi) {
    const okCount = day.intervals.filter((iv) => iv.status === 'ok').length;
    reasons.push({
      code: 'INTERVALS_SUMMARY',
      level: okCount > 0 ? 'ok' : 'bad',
      text: `共 ${day.intervals.length} 个允许时段（或关系）：${okCount} 段在该日天文可成立`,
    });
  }

  for (const iv of day.intervals) {
    for (const r of intervalReasons(iv, tz)) reasons.push(r);
  }

  const best = day.best;
  if (!best) {
    const anchor =
      day.intervals.find((iv) => iv.anchorAt)?.anchorAt ??
      day.intervals[0]?.anchorAt ??
      day.events.solarNoon;
    const measured = day.intervals.find((iv) => iv.measured.anchorPosition)?.measured.anchorPosition ?? null;
    reasons.push({
      code: 'WINDOW_EMPTY',
      level: 'bad',
      text: multi
        ? '所有允许时段都无法在该日同时满足仰角与方位角约束'
        : '没有满足全部天文约束的时刻',
    });
    return {
      date: dateKey,
      startAt: best?.band?.start ?? anchor,
      endAt: best?.band?.end ?? anchor,
      anchorAt: anchor,
      sunElevation: measured?.elevationDeg ?? null,
      sunAzimuth: measured?.azimuthDeg ?? null,
      verdict: 'bad',
      reasons,
      episode: null,
    };
  }

  const run = best.run!;
  // 采样步长用于补足「窗口时长」（最后一个采样点代表一个步长）
  const span = best.band
    ? Math.max(1, (best.band.end.getTime() - best.band.start.getTime()) / 60000)
    : 1;
  const stepMin = Math.max(1, Math.ceil(span / 300));
  const durationMin = (run.end.getTime() - run.start.getTime()) / 60000 + stepMin;

  let verdict: WindowVerdict = 'good';
  if (durationMin < 5) {
    verdict = 'marginal';
    reasons.push({
      code: 'WINDOW_TOO_SHORT',
      level: 'warn',
      text: `${intervalLabel(best)}：可用窗口仅约 ${durationMin.toFixed(0)} 分钟（少于 5 分钟）`,
    });
  }
  reasons.push({
    code: 'WINDOW_RANGE',
    level: 'ok',
    text: `${multi ? `${intervalLabel(best)} 给出最长窗口：` : ''}${formatLocal(run.start, tz, true)}–${formatLocal(
      run.end,
      tz,
      true,
    )}（约 ${durationMin.toFixed(0)} 分钟）`,
  });

  const mid = new Date((run.start.getTime() + run.end.getTime()) / 2);
  const midSample =
    best.samples
      .filter((s) => s.ok)
      .reduce<(typeof best.samples)[number] | null>(
        (acc, s) =>
          acc === null ||
          Math.abs(s.at.getTime() - mid.getTime()) < Math.abs(acc.at.getTime() - mid.getTime())
            ? s
            : acc,
        null,
      ) ?? best.samples[0] ?? null;

  // ---- 3) 天气项 ----
  const episode = summarizeEpisode(forecast, run.start, run.end);
  if (episode.degraded) {
    reasons.push({
      code: 'WEATHER_DEGRADED',
      level: 'warn',
      text: '天气源不可用：本次判定未包含天气，最高只能到「勉强」',
    });
    if (verdict === 'good') verdict = 'marginal';
  } else {
    const profile = timing.weatherProfile;
    const hard = new Set(profile.hardRequirements ?? ['precipProbPctMax']);
    const isNight = (midSample?.elevationDeg ?? best.measured.anchorPosition?.elevationDeg ?? 0) < -12;

    const check = (
      code: string,
      key: string,
      actual: number | null,
      limit: number,
      compare: 'max' | 'min',
      text: string,
    ): void => {
      if (actual === null) return;
      const violated = compare === 'max' ? actual > limit : actual < limit;
      if (!violated) {
        reasons.push({ code, level: 'ok', text });
        return;
      }
      const isHard = hard.has(key);
      reasons.push({
        code: `${code}_${isHard ? 'FAIL' : 'MARGINAL'}`,
        level: isHard ? 'bad' : 'warn',
        text,
      });
      if (isHard) verdict = 'bad';
      else if (verdict === 'good') verdict = 'marginal';
    };

    if (profile.precipProbPctMax !== undefined) {
      check(
        'PRECIP',
        'precipProbPctMax',
        episode.maxPrecipProbPct,
        profile.precipProbPctMax,
        'max',
        `降水概率 ${episode.maxPrecipProbPct?.toFixed(0) ?? '?'}%（上限 ${profile.precipProbPctMax}%）`,
      );
    }
    if (profile.windSpeedMax !== undefined) {
      check(
        'WIND',
        'windSpeedMax',
        episode.maxWindSpeedMs,
        profile.windSpeedMax,
        'max',
        `风速 ${episode.maxWindSpeedMs?.toFixed(1) ?? '?'} m/s（上限 ${profile.windSpeedMax}）`,
      );
    }
    if (profile.visibilityKmMin !== undefined) {
      check(
        'VISIBILITY',
        'visibilityKmMin',
        episode.minVisibilityKm,
        profile.visibilityKmMin,
        'min',
        `能见度 ${episode.minVisibilityKm?.toFixed(1) ?? '?'} km（下限 ${profile.visibilityKmMin}）`,
      );
    }

    if (profile.cloudCoverPct && episode.avgCloudCoverPct !== null) {
      const { min, max } = profile.cloudCoverPct;
      const cloud = episode.avgCloudCoverPct;
      const ok = cloud >= min && cloud <= max;
      const isHard = hard.has('cloudCoverPct');
      reasons.push({
        code: ok ? 'CLOUD_OK' : isHard ? 'CLOUD_FAIL' : 'CLOUD_MARGINAL',
        level: ok ? 'ok' : isHard ? 'bad' : 'warn',
        text: `云量 ${cloud.toFixed(0)}%（目标 ${min}%–${max}%）`,
      });
      if (!ok) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }

    if (profile.tempC && episode.avgTempC !== null) {
      const ok = episode.avgTempC >= profile.tempC.min && episode.avgTempC <= profile.tempC.max;
      const isHard = hard.has('tempC');
      reasons.push({
        code: ok ? 'TEMP_OK' : isHard ? 'TEMP_FAIL' : 'TEMP_MARGINAL',
        level: ok ? 'ok' : isHard ? 'bad' : 'warn',
        text: `气温 ${episode.avgTempC.toFixed(0)}℃（目标 ${profile.tempC.min}–${profile.tempC.max}℃）`,
      });
      if (!ok) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }

    for (const phenomenon of (profile.phenomena ?? []) as WeatherPhenomenon[]) {
      if (phenomenon === 'any') continue;
      const hit = phenomenonHolds(phenomenon, episode, isNight);
      const isHard = hard.has(`phenomenon:${phenomenon}`);
      reasons.push({
        code: hit ? 'PHENOMENON_OK' : isHard ? 'PHENOMENON_FAIL' : 'PHENOMENON_MARGINAL',
        level: hit ? 'ok' : isHard ? 'bad' : 'warn',
        text: `特殊现象「${phenomenon}」${hit ? '满足' : '不满足'}`,
      });
      if (!hit) {
        if (isHard) verdict = 'bad';
        else if (verdict === 'good') verdict = 'marginal';
      }
    }
  }

  return {
    date: dateKey,
    startAt: run.start,
    endAt: run.end,
    anchorAt: best.anchorAt ?? run.start,
    sunElevation: midSample?.elevationDeg ?? null,
    sunAzimuth: midSample?.azimuthDeg ?? null,
    verdict,
    reasons,
    episode,
  };
}

/** evaluateDay 需要的太阳事件函数由 @flil/shared 直接导入（sunEvents）。 */

export interface ComputeOptions {
  days?: number;
  now?: Date;
}

/**
 * 计算并落库某条灵感卡的未来窗口。
 * 幂等：同一 (inspiration, date) 只保留一条窗口；被计划引用的窗口原地更新，避免打断闭环。
 */
export async function computeWindowsForInspiration(
  inspirationId: string,
  opts: ComputeOptions = {},
): Promise<ReproWindowDto[]> {
  const db = getDb();
  const inspiration = db
    .prepare('SELECT id, library_id, spot_id FROM inspiration WHERE id = ?')
    .get(inspirationId) as { id: string; library_id: string; spot_id: string | null } | undefined;
  if (!inspiration) throw errors.notFound('灵感卡');

  const timingRow = loadTiming(inspirationId);
  if (!timingRow) throw errors.timingIncomplete('该卡片还没有设置拍摄条件');
  const timing = timingRowToDto(timingRow);

  if (!inspiration.spot_id) {
    return [];
  }
  const spot = loadSpotGeom(inspiration.spot_id);
  if (!spot) return [];

  const days = opts.days ?? config.windowForecastDays;
  const now = opts.now ?? new Date();
  const todayKey = localDateKey(now, spot.tz);
  const forecast = await getForecast(spot.lat, spot.lng, days);

  const results: DayResult[] = [];
  for (let i = 0; i < days; i += 1) {
    const key = addDaysToKey(todayKey, i);
    results.push(computeDay(spot, timing, key, forecast));
  }

  const previous = db
    .prepare('SELECT id, date, verdict, start_at FROM repro_window WHERE inspiration_id = ?')
    .all(inspirationId) as { id: string; date: string; verdict: string; start_at: string }[];
  const previousByDate = new Map(previous.map((p) => [p.date, p]));
  const plannedWindowIds = new Set(
    (
      db
        .prepare('SELECT window_id FROM shoot_plan WHERE inspiration_id = ? AND window_id IS NOT NULL')
        .all(inspirationId) as { window_id: string }[]
    ).map((r) => r.window_id),
  );

  const ts = nowIso();
  const dtos: ReproWindowDto[] = [];

  const persist = db.transaction(() => {
    for (const r of results) {
      const prior = previousByDate.get(r.date);
      let id: string;
      if (prior && plannedWindowIds.has(prior.id)) {
        // 已被出行计划引用 → 原地更新，保住闭环链路
        id = prior.id;
        db.prepare(
          `UPDATE repro_window SET start_at=?, end_at=?, anchor_at=?, sun_elevation=?, sun_azimuth=?,
             verdict=?, reasons=?, forecast_snapshot=?, weather_degraded=?, stale=0, computed_at=?
           WHERE id=?`,
        ).run(
          r.startAt.toISOString(),
          r.endAt.toISOString(),
          r.anchorAt.toISOString(),
          r.sunElevation,
          r.sunAzimuth,
          r.verdict,
          toJson(r.reasons),
          r.episode ? toJson(r.episode) : null,
          r.episode?.degraded ? 1 : 0,
          ts,
          id,
        );
      } else {
        if (prior) {
          db.prepare('DELETE FROM repro_window WHERE inspiration_id = ? AND date = ?').run(inspirationId, r.date);
        }
        id = newId();
        db.prepare(
          `INSERT INTO repro_window (id, library_id, inspiration_id, date, start_at, end_at, anchor_at,
             sun_elevation, sun_azimuth, verdict, reasons, forecast_snapshot, weather_degraded, stale, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        ).run(
          id,
          inspiration.library_id,
          inspirationId,
          r.date,
          r.startAt.toISOString(),
          r.endAt.toISOString(),
          r.anchorAt.toISOString(),
          r.sunElevation,
          r.sunAzimuth,
          r.verdict,
          toJson(r.reasons),
          r.episode ? toJson(r.episode) : null,
          r.episode?.degraded ? 1 : 0,
          ts,
        );
      }

      if (prior && prior.verdict !== r.verdict) {
        emitEvent({
          type: 'window_changed',
          libraryId: inspiration.library_id,
          payload: { inspirationId, date: r.date, from: prior.verdict, to: r.verdict },
        });
      }

      dtos.push({
        id,
        inspirationId,
        date: r.date,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        anchorAt: r.anchorAt.toISOString(),
        sunElevation: r.sunElevation,
        sunAzimuth: r.sunAzimuth,
        verdict: r.verdict,
        reasons: r.reasons,
        weatherDegraded: r.episode?.degraded ?? true,
        stale: false,
        computedAt: ts,
      });
    }
  });
  persist();

  return dtos;
}

export function listWindows(inspirationId: string): ReproWindowDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM repro_window WHERE inspiration_id = ? ORDER BY date ASC, start_at ASC')
    .all(inspirationId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    inspirationId: r.inspiration_id as string,
    date: r.date as string,
    startAt: r.start_at as string,
    endAt: r.end_at as string,
    anchorAt: r.anchor_at as string,
    sunElevation: (r.sun_elevation as number | null) ?? null,
    sunAzimuth: (r.sun_azimuth as number | null) ?? null,
    verdict: r.verdict as WindowVerdict,
    reasons: parseJson<WindowReasonDto[]>(r.reasons, []),
    weatherDegraded: r.weather_degraded === 1,
    stale: r.stale === 1,
    computedAt: (r.computed_at as string | null) ?? null,
  }));
}

export function windowSummary(
  inspirationId: string,
  now = new Date(),
): { nextGoodAt: string | null; goodIn30d: number } {
  const db = getDb();
  const nowIsoStr = now.toISOString();
  const next = db
    .prepare(
      `SELECT start_at FROM repro_window WHERE inspiration_id = ? AND verdict = 'good' AND start_at >= ?
       ORDER BY start_at ASC LIMIT 1`,
    )
    .get(inspirationId, nowIsoStr) as { start_at: string } | undefined;
  const until = new Date(now.getTime() + 30 * 86400000).toISOString();
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id = ? AND verdict = 'good'
       AND start_at >= ? AND start_at <= ?`,
    )
    .get(inspirationId, nowIsoStr, until) as { n: number };
  return { nextGoodAt: next?.start_at ?? null, goodIn30d: count.n };
}

export { addMinutes, formatLocal };
