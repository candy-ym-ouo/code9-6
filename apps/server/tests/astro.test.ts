import { describe, expect, it } from 'vitest';
import {
  angularDistance,
  azimuthArcContains,
  bandToRange,
  clockIntervalToUtc,
  effectiveAzimuthArcs,
  elevationAt,
  evaluateAstronomy,
  formatClockInterval,
  resolveAnchor,
  solarPosition,
  sunEvents,
  theoreticalOkForDay,
  utcToZonedParts,
  validateTiming,
  zonedTimeToUtc,
  type TimingDto,
} from '@flil/shared';

const SHANGHAI = { lat: 31.23, lng: 121.47, tz: 'Asia/Shanghai' };

function baseTiming(patch: Partial<TimingDto> = {}): TimingDto {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthArcs: [],
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    allowedIntervals: [],
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
    ...patch,
  };
}

describe('太阳位置算法', () => {
  it('正午方位角接近正南（北半球中纬度）', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const pos = solarPosition(events.solarNoon, SHANGHAI.lat, SHANGHAI.lng);
    expect(angularDistance(pos.azimuthDeg, 180)).toBeLessThan(0.5);
  });

  it('上海 2026-10-11 的日出日落时刻与真实值一致（±4 分钟）', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const sunrise = utcToZonedParts(events.sunrise!, SHANGHAI.tz);
    const sunset = utcToZonedParts(events.sunset!, SHANGHAI.tz);
    const minutes = (h: number, m: number, tH: number, tM: number) => Math.abs(h * 60 + m - (tH * 60 + tM));
    expect(minutes(sunrise.hour, sunrise.minute, 5, 53)).toBeLessThanOrEqual(4);
    expect(minutes(sunset.hour, sunset.minute, 17, 27)).toBeLessThanOrEqual(4);
  });

  it('黄金时刻（昏）的仰角区间落在 -4° ~ +6°', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const start = elevationAt(events.goldenPm!.start, SHANGHAI.lat, SHANGHAI.lng);
    const end = elevationAt(events.goldenPm!.end, SHANGHAI.lat, SHANGHAI.lng);
    expect(start).toBeGreaterThan(5.5);
    expect(start).toBeLessThan(6.5);
    expect(end).toBeLessThan(-3.5);
    expect(end).toBeGreaterThan(-4.5);
  });

  it('太阳仰角在一天内先升后降（单调性正确）', () => {
    const day = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-06-21');
    const morning = elevationAt(new Date(day.solarNoon.getTime() - 3 * 3600000), SHANGHAI.lat, SHANGHAI.lng);
    const noon = day.maxElevationDeg;
    const evening = elevationAt(new Date(day.solarNoon.getTime() + 3 * 3600000), SHANGHAI.lat, SHANGHAI.lng);
    expect(noon).toBeGreaterThan(morning);
    expect(noon).toBeGreaterThan(evening);
  });
});

describe('极端纬度（极昼 / 极夜）', () => {
  it('斯瓦尔巴 6 月为极昼，无日出日落锚点', () => {
    const events = sunEvents(78.22, 15.65, 'Europe/Oslo', '2026-06-21');
    expect(events.polar).toBe('midnight_sun');
    expect(events.sunrise).toBeNull();
  });

  it('斯瓦尔巴 12 月为极夜，锚点返回 null 而不是错误时间', () => {
    const events = sunEvents(78.22, 15.65, 'Europe/Oslo', '2026-12-21');
    expect(events.polar).toBe('polar_night');
    expect(resolveAnchor(events, baseTiming({ timeAnchor: 'golden_pm' }))).toBeNull();
    expect(resolveAnchor(events, baseTiming({ timeAnchor: 'sunset_minus' }))).toBeNull();
  });
});

describe('时间锚解析', () => {
  it('日落前 40 分钟 = 日落时刻 − 40 分钟', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'sunset_minus', anchorOffsetMin: 40 }))!;
    expect(events.sunset!.getTime() - resolved.anchorAt.getTime()).toBe(40 * 60000);
  });

  it('黄金时刻锚点自带仰角区间', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'golden_pm' }))!;
    expect(resolved.elevationRange).toEqual([-4, 6]);
    expect(resolved.band).not.toBeNull();
  });

  it('固定钟点按机位时区解释', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'fixed_clock', anchorOffsetMin: 10 * 60 }))!;
    const parts = utcToZonedParts(resolved.anchorAt, SHANGHAI.tz);
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(0);
  });

  it('带偏移的锚点用 ±windowToleranceMin 生成窗口', () => {
    const events = sunEvents(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11');
    const resolved = resolveAnchor(events, baseTiming({ timeAnchor: 'sunset', windowToleranceMin: 15 }))!;
    const [start, end] = bandToRange(resolved, baseTiming({ timeAnchor: 'sunset', windowToleranceMin: 15 }));
    expect(start.getTime() - resolved.anchorAt.getTime()).toBe(-15 * 60000);
    expect(end.getTime() - resolved.anchorAt.getTime()).toBe(15 * 60000);
  });

  it('时区换算：同一时刻在不同时区得到不同墙上时间', () => {
    const instant = zonedTimeToUtc('Asia/Shanghai', 2026, 10, 11, 17, 30);
    expect(utcToZonedParts(instant, 'Asia/Shanghai').hour).toBe(17);
    expect(utcToZonedParts(instant, 'UTC').hour).toBe(9);
  });
});

describe('年度理论可成立天数', () => {
  it('季节窗口外的日期直接判定为不可成立', () => {
    const timing = baseTiming({ seasonWindow: { fromMonth: 9, toMonth: 3 } });
    expect(theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-07-01', timing)).toBe(false);
    expect(theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-11-01', timing)).toBe(true);
  });

  it('极严的仰角区间会显著减少可成立天数（说明可满足性检查有意义）', () => {
    // 用不带自带仰角区间的锚点（sunset_minus），用户仰角区间才完全生效
    const loose = baseTiming({ timeAnchor: 'sunset_minus', elevationRange: [-90, 90] });
    const strict = baseTiming({ timeAnchor: 'sunset_minus', elevationRange: [-4.02, -3.98] });
    const count = (t: TimingDto) =>
      Array.from({ length: 60 }, (_, i) => {
        const d = new Date(Date.UTC(2026, 8, 1 + i));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
          d.getUTCDate(),
        ).padStart(2, '0')}`;
        return theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, key, t);
      }).filter(Boolean).length;
    expect(count(loose)).toBeGreaterThan(count(strict));
  });

  it('自带仰角区间的锚点（golden_pm）在预览与可满足率两处口径一致', () => {
    // 旧实现里 theoreticalOkForDay 用用户区间、computeDay 用锚点区间，会互相矛盾；
    // 统一后用户的极窄区间不应影响 golden_pm（锚点自带 [-4,6]）
    const t = baseTiming({ timeAnchor: 'golden_pm', elevationRange: [-4.02, -3.98] });
    const ok = theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', t);
    expect(ok).toBe(true);
  });
});

describe('方位角圆弧（环形）', () => {
  it('跨正北的弧 350°→10° 正确包含两侧、排除正南', () => {
    const arc = { startDeg: 350, endDeg: 10 };
    expect(azimuthArcContains(355, arc)).toBe(true);
    expect(azimuthArcContains(0, arc)).toBe(true);
    expect(azimuthArcContains(10, arc)).toBe(true);
    expect(azimuthArcContains(180, arc)).toBe(false);
    expect(azimuthArcContains(200, arc)).toBe(false);
  });

  it('普通弧不跨正北', () => {
    const arc = { startDeg: 80, endDeg: 100 };
    expect(azimuthArcContains(90, arc)).toBe(true);
    expect(azimuthArcContains(270, arc)).toBe(false);
  });
  it('普通弧贴边 [0,90] 不应被外扩容差翻成跨正北补集', () => {
    const timing = baseTiming({ azimuthArcs: [{ startDeg: 0, endDeg: 90 }] });
    const arcs = effectiveAzimuthArcs(timing);
    expect(arcs[0].startDeg).toBeGreaterThanOrEqual(0);
    expect(arcs[0].endDeg).toBeLessThanOrEqual(91);
    expect(azimuthArcContains(45, arcs[0])).toBe(true);
    expect(azimuthArcContains(270, arcs[0])).toBe(false);
  });

  it('结束于 360 的弧把正北 0° 作为闭合端点包含', () => {
    expect(azimuthArcContains(0, { startDeg: 350, endDeg: 360 })).toBe(true);
    expect(azimuthArcContains(180, { startDeg: 350, endDeg: 360 })).toBe(false);
  });

  it('中心±180 容差退化为整圈', () => {
    const timing = baseTiming({ azimuthRange: [0, 0], azimuthTolerance: 180 });
    const arcs = effectiveAzimuthArcs(timing);
    expect(azimuthArcContains(123, arcs[0])).toBe(true);
  });

  it('旧 azimuthRange（中心±容差）在跨正北时也能命中', () => {
    // 旧字段语义是 [center, center]：中心 355° ± 15° 展开为跨正北的弧 340°→10°
    const timing = baseTiming({ azimuthRange: [355, 355], azimuthTolerance: 15 });
    const arcs = effectiveAzimuthArcs(timing);
    expect(azimuthArcContains(0, arcs[0])).toBe(true);
    expect(azimuthArcContains(180, arcs[0])).toBe(false);
  });

  it('无效方位范围被可解释地拒绝', () => {
    const zeroArc = validateTiming(baseTiming({ azimuthArcs: [{ startDeg: 90, endDeg: 90 }] }));
    expect(zeroArc.some((i) => i.path.startsWith('azimuthArcs') && /零宽/.test(i.message))).toBe(true);

    const both = validateTiming(
      baseTiming({ azimuthRange: [10, 10], azimuthArcs: [{ startDeg: 0, endDeg: 90 }] }),
    );
    expect(both.length).toBeGreaterThan(0);
    expect(both[0].message).toMatch(/不能同时/);

    const elevReversed = validateTiming(baseTiming({ elevationRange: [20, 10] }));
    expect(elevReversed[0].message).toMatch(/方向反了/);

    const elevPhysical = validateTiming(baseTiming({ elevationRange: [-91, 5] }));
    expect(elevPhysical[0].message).toMatch(/-90/);

    const fullCircle = validateTiming(baseTiming({ azimuthArcs: [{ startDeg: 0, endDeg: 360 }] }));
    expect(fullCircle[0].message).toMatch(/任意方位/);
  });
});

describe('多段允许钟点区间（含跨午夜）', () => {
  it('跨午夜区间映射到相邻两个 UTC 日', () => {
    const iv = { startMin: 23 * 60, endMin: 60 }; // 23:00–次日 01:00
    const { start, end } = clockIntervalToUtc('2026-10-11', 'Asia/Shanghai', iv);
    const s = utcToZonedParts(start, 'Asia/Shanghai');
    const e = utcToZonedParts(end, 'Asia/Shanghai');
    expect({ d: s.day, h: s.hour, m: s.minute }).toEqual({ d: 11, h: 23, m: 0 });
    expect({ d: e.day, h: e.month, m: e.minute }).toEqual({ d: 12, h: 10, m: 0 });
    expect(end.getTime() - start.getTime()).toBe(2 * 3600000);
    expect(formatClockInterval(iv)).toMatch(/次日/);
  });

  it('不跨午夜区间落在同一天', () => {
    const iv = { startMin: 6 * 60, endMin: 8 * 60 };
    const { start, end } = clockIntervalToUtc('2026-10-11', 'UTC', iv);
    expect(start.toISOString()).toBe('2026-10-11T06:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-11T08:00:00.000Z');
  });

  it('零长度区间被拒绝', () => {
    const issues = validateTiming(baseTiming({ allowedIntervals: [{ startMin: 300, endMin: 300 }] }));
    expect(issues[0].message).toMatch(/零长度/);
  });

  it('跨午夜允许区间在窗口判定中生效：只允许深夜时，日落锚点窗口不成立', () => {
    // 上海 10 月日落约 17:27，日落前 40 分约 16:47；把允许区间设为 22:00–次日 02:00 → 不成立
    const t = baseTiming({ allowedIntervals: [{ startMin: 22 * 60, endMin: 2 * 60 }] });
    const evalDay = evaluateAstronomy(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', t);
    expect(evalDay.verdict).toBe('bad');
    expect(evalDay.segments).toHaveLength(1);
    expect(evalDay.segments[0].rejected).toBe(true);
    expect(theoreticalOkForDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', t)).toBe(false);
  });

  it('多段区间：日落段不满足仰角但深夜段满足夜间仰角 → 整天仍可成立（OR 语义）', () => {
    const t = baseTiming({
      timeAnchor: 'sunset_minus',
      elevationRange: [-90, 90],
      allowedIntervals: [
        { startMin: 16 * 60 + 40, endMin: 17 * 60 + 5 }, // 覆盖日落前 40 分
        { startMin: 23 * 60, endMin: 23 * 60 + 30 },
      ],
    });
    const evalDay = evaluateAstronomy(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', t);
    expect(evalDay.verdict).not.toBe('bad');
    expect(evalDay.segments.filter((s) => !s.rejected).length).toBeGreaterThanOrEqual(1);
  });

  it('跨午夜方位弧 + 跨午夜区间：午夜太阳在北侧，南侧小弧必然 AZIMUTH_MISS', () => {
    // 上海 23:00 前后太阳在地平线下、方位角接近正北（0°）；要求 170°→190° 南侧小弧 → 不成立
    const t = baseTiming({
      elevationRange: [-90, 90],
      azimuthRange: null,
      azimuthArcs: [{ startDeg: 170, endDeg: 190 }],
      allowedIntervals: [{ startMin: 23 * 60, endMin: 23 * 60 + 30 }],
    });
    const evalDay = evaluateAstronomy(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', t);
    expect(evalDay.verdict).toBe('bad');
    expect(evalDay.segments[0].failureCode).toBe('AZIMUTH_MISS');
  });
});

describe('极区：预览/可满足率/窗口判定一致', () => {
  const SVALBARD = { lat: 78.22, lng: 15.65, tz: 'Europe/Oslo' };

  it('极夜日：sunset 锚点三处都判 bad 且理由是 ANCHOR_UNRESOLVABLE', () => {
    const t = baseTiming({ timeAnchor: 'sunset_minus', anchorOffsetMin: 40 });
    const date = '2026-12-21';
    const evalDay = evaluateAstronomy(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t);
    expect(evalDay.verdict).toBe('bad');
    expect(evalDay.polar).toBe('polar_night');
    expect(evalDay.reasons.some((r) => r.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    expect(theoreticalOkForDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t)).toBe(false);
  });

  it('极昼日：即便设了跨午夜允许区间，无锚点锚（sunset）仍整体 bad', () => {
    const t = baseTiming({
      timeAnchor: 'sunset',
      allowedIntervals: [
        { startMin: 22 * 60, endMin: 2 * 60 },
        { startMin: 10 * 60, endMin: 14 * 60 },
      ],
    });
    const date = '2026-06-21';
    const evalDay = evaluateAstronomy(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t);
    expect(evalDay.polar).toBe('midnight_sun');
    expect(evalDay.verdict).toBe('bad');
    expect(theoreticalOkForDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t)).toBe(false);
  });

  it('极昼日：solar_noon 锚点 + 全天允许区间可成立', () => {
    const t = baseTiming({
      timeAnchor: 'solar_noon',
      elevationRange: [0, 35],
      allowedIntervals: [{ startMin: 10 * 60, endMin: 14 * 60 }],
    });
    const date = '2026-06-21';
    const evalDay = evaluateAstronomy(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t);
    expect(evalDay.verdict).not.toBe('bad');
    expect(theoreticalOkForDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, date, t)).toBe(true);
  });
});
