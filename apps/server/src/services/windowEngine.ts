import {
  addDaysToKey,
  addMinutes,
  evaluateAstronomy,
  formatLocal,
  localDateKey,
  solarPosition,
  type AstronomyEvaluation,
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
  azimuth_arcs: string;
  azimuth_tolerance: number;
  window_tolerance_min: number;
  allowed_intervals: string;
  weather_profile: string;
  season_window: string | null;
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

export function timingRowToDto(row: TimingRow): TimingDto {
  return {
    timeAnchor: row.time_anchor,
    anchorOffsetMin: row.anchor_offset_min,
    elevationRange: parseJson<number[]>(row.elevation_range, [-90, 90]),
    azimuthRange: row.azimuth_range ? parseJson<number[] | null>(row.azimuth_range, null) : null,
    azimuthArcs: parseJson<TimingDto['azimuthArcs']>(row.azimuth_arcs, []),
    azimuthTolerance: row.azimuth_tolerance,
    windowToleranceMin: row.window_tolerance_min,
    allowedIntervals: parseJson<TimingDto['allowedIntervals']>(row.allowed_intervals, []),
    weatherProfile: parseJson(row.weather_profile, {}),
    seasonWindow: row.season_window
      ? parseJson<{ fromMonth: number; toMonth: number } | null>(row.season_window, null)
      : null,
    notes: row.notes,
  };
}

export function loadTiming(inspirationId: string): TimingRow | null {
  return (
    (getDb().prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(inspirationId) as TimingRow | undefined) ??
    null
  );
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

/**
 * 判定单日窗口（文档 12.4 的算法，逐项产出 reasons）。
 * 天文/季节部分一律走共享的 evaluateAstronomy——与预览、可满足率是同一份代码，
 * 保证多段允许区间（含跨午夜）与极区结论在三处完全一致；这里只叠加天气项。
 */
export function computeDay(
  spot: SpotGeom,
  timing: TimingDto,
  dateKey: string,
  forecast: Awaited<ReturnType<typeof getForecast>>,
): DayResult {
  const tz = spot.tz;
  const astro = evaluateAstronomy(spot.lat, spot.lng, tz, dateKey, timing);
  const reasons = [...astro.reasons];

  const fallbackAt = astro.anchorAt;
  // 天文失败但锚点可解析时，沿用旧实现落"候选时段端点"；锚点不可解析（极区/季节外）才退化为锚点时刻
  const segStart = astro.segments[0]?.startAt ?? fallbackAt;
  const segEnd = astro.segments[0]?.endAt ?? fallbackAt;
  const fail = (
    extra: WindowReasonDto[] = [],
  ): DayResult => ({
    date: dateKey,
    startAt: segStart,
    endAt: segEnd,
    anchorAt: fallbackAt,
    sunElevation: astro.sunElevation,
    sunAzimuth: astro.sunAzimuth,
    verdict: 'bad',
    reasons: [...reasons, ...extra],
    episode: null,
  });

  if (astro.verdict === 'bad' || !astro.bestSegment?.run) {
    return fail();
  }

  const run = astro.bestSegment.run;
  let verdict: WindowVerdict = astro.verdict; // 'good' | 'marginal'（<5 分钟）

  const mid = new Date((run.start.getTime() + run.end.getTime()) / 2);
  const midPos = solarPosition(mid, spot.lat, spot.lng);

  // ---- 天气项 ----
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
    const isNight = midPos.elevationDeg < -12;

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
    anchorAt: astro.anchorAt,
    sunElevation: midPos.elevationDeg,
    sunAzimuth: midPos.azimuthDeg,
    verdict,
    reasons,
    episode,
  };
}

/** 供预览复用：直接返回单日天文评估（含每段窗口），不落库 */
export function previewAstronomy(spot: SpotGeom, timing: TimingDto, dateKey: string): AstronomyEvaluation {
  return evaluateAstronomy(spot.lat, spot.lng, spot.tz, dateKey, timing);
}

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
