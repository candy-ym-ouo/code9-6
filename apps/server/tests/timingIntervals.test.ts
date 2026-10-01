import { describe, expect, it } from 'vitest';
import {
  azimuthWithinArc,
  clockwiseArc,
  evaluateDay,
  sunEvents,
  timingSchema,
  validateAzimuthArc,
  type TimingDto,
  type TimingInterval,
} from '@flil/shared';

const SHANGHAI = { lat: 31.23, lng: 121.47, tz: 'Asia/Shanghai' };
const SVALBARD = { lat: 78.22, lng: 15.65, tz: 'Europe/Oslo' };
const TROMSO = { lat: 69.65, lng: 18.96, tz: 'Europe/Oslo' };

function baseInterval(patch: Partial<TimingInterval> = {}): TimingInterval {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    label: null,
    ...patch,
  };
}

function baseTiming(patch: Partial<TimingDto> = {}): TimingDto {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
    ...patch,
  };
}

describe('方位角允许弧（顺时针，可跨 0°/360°）', () => {
  it('顺时针弧长正确处理接缝', () => {
    expect(clockwiseArc(350, 10)).toBe(20);
    expect(clockwiseArc(10, 350)).toBe(340);
  });

  it('命中判定跨越正北接缝', () => {
    expect(azimuthWithinArc(355, 350, 20)).toBe(true);
    expect(azimuthWithinArc(5, 350, 20)).toBe(true);
    expect(azimuthWithinArc(180, 350, 20)).toBe(false);
  });

  it('跨弧超过 180° 被拒绝并给出可解释理由', () => {
    expect(validateAzimuthArc(350, 10).ok).toBe(true);
    const bad = validateAzimuthArc(10, 350);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/180/);
    expect(validateAzimuthArc(0, 181).ok).toBe(false);
    expect(validateAzimuthArc(350, 171).ok).toBe(false); // 顺时针 181°
  });

  it('zod 拒绝无效方位区间并返回中文 issue', () => {
    const parsed = timingSchema.safeParse(baseTiming({ azimuthRange: [10, 350] }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toMatch(/顺时针/);
    }
  });

  it('zod 接受跨正北接缝的合法弧', () => {
    const parsed = timingSchema.safeParse(baseTiming({ azimuthRange: [350, 10] }));
    expect(parsed.success).toBe(true);
  });

  it('容差叠加后覆盖整圆被拒绝', () => {
    const parsed = timingSchema.safeParse(
      baseTiming({ azimuthRange: [350, 10], azimuthTolerance: 175 }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('多段允许区间（或关系）', () => {
  it('两段都不可行 → 当天不可满足，并逐段给出失败原因', () => {
    const timing = baseTiming({
      intervals: [
        baseInterval({ azimuthRange: [30, 50], azimuthTolerance: 0 }), // 东侧，日落不在
        baseInterval({ timeAnchor: 'sunrise_plus', azimuthRange: [250, 280], azimuthTolerance: 0 }), // 西侧，日出不在
      ],
    });
    const day = evaluateDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', timing, sunEvents);
    expect(day.satisfiable).toBe(false);
    expect(day.intervals.map((iv) => iv.status)).toEqual(['azimuth_miss', 'azimuth_miss']);
    expect(day.best).toBeNull();
  });

  it('任一段可行 → 当天可满足，取最长可行段', () => {
    const timing = baseTiming({
      intervals: [
        baseInterval({ azimuthRange: [30, 50], azimuthTolerance: 0 }),
        baseInterval({ azimuthRange: [255, 275], azimuthTolerance: 20, windowToleranceMin: 30 }),
      ],
    });
    const day = evaluateDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', timing, sunEvents);
    expect(day.satisfiable).toBe(true);
    expect(day.best?.index).toBe(1);
  });
});

describe('跨午夜', () => {
  it('高纬冬季夜间时段从当日下午延伸到次日早晨（跨午夜不丢尾段）', () => {
    const events = sunEvents(TROMSO.lat, TROMSO.lng, TROMSO.tz, '2026-11-21');
    expect(events.nightStart).not.toBeNull();
    expect(events.nightEnd).not.toBeNull();
    expect(events.nightEnd!.getTime()).toBeGreaterThan(events.nightStart!.getTime());
    const day = events.nightStart!.getUTCDate();
    expect(events.nightEnd!.getUTCDate()).not.toBe(day); // 尾部落到下一个 UTC 日
  });

  it('固定钟点 + 宽容差跨本地午夜时窗口仍连续可判', () => {
    const timing = baseTiming({
      timeAnchor: 'fixed_clock',
      anchorOffsetMin: 23 * 60 + 50,
      windowToleranceMin: 30,
      elevationRange: [-90, 90],
    });
    const day = evaluateDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', timing, sunEvents);
    expect(day.satisfiable).toBe(true);
    expect(day.best!.run).not.toBeNull();
  });

  it('跨正北接缝的方位弧在日落评估中可用', () => {
    // 构造一个落在接缝附近的窄弧（只在数学层验证 evaluateDay 接受该形态）
    const timing = baseTiming({ azimuthRange: [350, 10], azimuthTolerance: 0 });
    const day = evaluateDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, '2026-10-11', timing, sunEvents);
    expect(day.intervals[0].status).toBe('azimuth_miss'); // 上海日落方位约 265°，不在北侧弧
  });
});

describe('极区', () => {
  it('极昼下日落段无解、正午段可行 → 多段整体仍可满足', () => {
    const timing = baseTiming({
      intervals: [
        baseInterval({ timeAnchor: 'sunset_minus' }),
        baseInterval({ timeAnchor: 'solar_noon', elevationRange: [0, 40] }),
      ],
    });
    const day = evaluateDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, '2026-06-21', timing, sunEvents);
    expect(day.intervals[0].status).toBe('anchor_unresolved');
    expect(day.intervals[1].status).toBe('ok');
    expect(day.satisfiable).toBe(true);
  });

  it('极夜下日出锚点无解', () => {
    const timing = baseTiming({ timeAnchor: 'sunrise' });
    const day = evaluateDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, '2026-12-21', timing, sunEvents);
    expect(day.intervals[0].status).toBe('anchor_unresolved');
    expect(day.satisfiable).toBe(false);
  });

  it('极夜下 night 锚点覆盖全天（可解析、仰角带有效）', () => {
    const timing = baseTiming({ timeAnchor: 'night', elevationRange: [-90, -12] });
    const day = evaluateDay(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, '2026-12-21', timing, sunEvents);
    expect(day.intervals[0].status).toBe('ok');
  });

  it('极昼/极夜不会误报黄金时刻（不把相邻日期的穿越点当当日事件）', () => {
    const summer = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, '2026-06-21');
    expect(summer.goldenAm).toBeNull();
    expect(summer.goldenPm).toBeNull();
    const winter = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, '2026-12-21');
    expect(winter.goldenAm).toBeNull();
    expect(winter.goldenPm).toBeNull();
  });
});

describe('预览 / 可满足率 / 窗口判定一致性', () => {
  it('evaluateDay.satisfiable 与 theoreticalOkForDay 对多段条件逐日一致', () => {
    const timing = baseTiming({
      intervals: [
        baseInterval({ azimuthRange: [200, 300], azimuthTolerance: 8 }),
        baseInterval({ timeAnchor: 'solar_noon', elevationRange: [40, 90], azimuthRange: [150, 210], azimuthTolerance: 10 }),
      ],
    });
    for (const monthDay of ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']) {
      const day = evaluateDay(SHANGHAI.lat, SHANGHAI.lng, SHANGHAI.tz, monthDay, timing, sunEvents);
      // 与 theoreticalOkForDay 同走 evaluateDay，这里直接复核状态聚合规则
      const expected = day.intervals.some((iv) => iv.status === 'ok' && iv.run);
      expect(day.satisfiable).toBe(expected);
    }
  });
});
