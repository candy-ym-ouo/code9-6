/**
 * 时间锚条件的跨字段语义校验（zod 只负责形状/边界，这里负责"人类能看懂"的拒绝理由）。
 * 预览、保存两条入口都必须走这里——绝不让无效条件静默落库后在窗口判定里变成莫名其妙的 bad。
 */
import type { TimingDto } from './types.js';

export interface TimingIssue {
  path: string;
  message: string;
}

export function validateTiming(timing: TimingDto): TimingIssue[] {
  const issues: TimingIssue[] = [];

  // ---- 仰角区间 ----
  const [elevLo, elevHi] = timing.elevationRange;
  if (![elevLo, elevHi].every((v) => Number.isFinite(v))) {
    issues.push({ path: 'elevationRange', message: '仰角区间必须是有限数字' });
  } else if (elevLo < -90 || elevHi > 90) {
    issues.push({ path: 'elevationRange', message: '太阳仰角只可能落在 -90°～90°，区间超出该物理范围' });
  } else if (elevLo > elevHi) {
    issues.push({
      path: 'elevationRange',
      message: `仰角区间方向反了：下界 ${elevLo}° 大于上界 ${elevHi}°（请改为 [小, 大]）`,
    });
  }

  // ---- 方位角 ----
  if (timing.azimuthRange && timing.azimuthArcs.length > 0) {
    issues.push({
      path: 'azimuthArcs',
      message: '不能同时使用「单一方位中心」和「多段方位弧」，请只保留一种方位角约束',
    });
  }
  if (timing.azimuthRange) {
    const [a, b] = timing.azimuthRange;
    if (![a, b].every((v) => Number.isFinite(v))) {
      issues.push({ path: 'azimuthRange', message: '方位角必须是有限数字' });
    } else if (a < 0 || a > 360) {
      issues.push({ path: 'azimuthRange', message: `方位角中心 ${a}° 超出 0°～360°` });
    } else if (a === 0 && b === 360) {
      issues.push({
        path: 'azimuthRange',
        message: '方位范围 [0, 360] 语义有歧义；要表达"任意方位"请直接关闭方位角约束',
      });
    }
  }
  timing.azimuthArcs.forEach((arc, i) => {
    const p = `azimuthArcs[${i}]`;
    if (![arc.startDeg, arc.endDeg].every((v) => Number.isFinite(v))) {
      issues.push({ path: p, message: '方位弧端点必须是有限数字' });
      return;
    }
    if (arc.startDeg < 0 || arc.startDeg > 360 || arc.endDeg < 0 || arc.endDeg > 360) {
      issues.push({ path: p, message: `第 ${i + 1} 段方位弧端点超出 0°～360°` });
      return;
    }
    if (arc.startDeg === 0 && arc.endDeg === 360) {
      issues.push({
        path: `${p}.endDeg`,
        message: '方位范围 [0, 360] 语义有歧义（顺时针整圈 vs 零宽）；要表达"任意方位"请直接关闭方位角约束',
      });
      return;
    }
    if (arc.startDeg === arc.endDeg) {
      issues.push({
        path: `${p}.endDeg`,
        message: `第 ${i + 1} 段方位弧起终点都是 ${arc.startDeg}°（零宽弧不含任何方向，属无效范围）`,
      });
    }
  });
  if (!(timing.azimuthTolerance >= 0 && timing.azimuthTolerance <= 180)) {
    issues.push({ path: 'azimuthTolerance', message: '方位角容差必须在 0°～180° 之间' });
  }

  // ---- 多段允许钟点区间 ----
  timing.allowedIntervals.forEach((iv, i) => {
    const p = `allowedIntervals[${i}]`;
    if (!Number.isInteger(iv.startMin) || !Number.isInteger(iv.endMin)) {
      issues.push({ path: p, message: `第 ${i + 1} 段允许区间的钟点必须是整数分钟` });
      return;
    }
    if (iv.startMin < 0 || iv.startMin > 1439 || iv.endMin < 0 || iv.endMin > 1440) {
      issues.push({ path: p, message: `第 ${i + 1} 段允许区间超出一天的钟点范围（00:00–24:00）` });
      return;
    }
    if (iv.endMin === iv.startMin) {
      issues.push({
        path: `${p}.endMin`,
        message: `第 ${i + 1} 段允许区间不能为零长度（${iv.startMin} 分起止相同）；想表达全天请删去该区间`,
      });
    }
  });
  const seen = new Set<string>();
  for (const iv of timing.allowedIntervals) {
    const key = `${iv.startMin}-${iv.endMin}`;
    if (seen.has(key)) {
      issues.push({ path: 'allowedIntervals', message: '允许区间存在完全重复的段落，请删除重复项' });
      break;
    }
    seen.add(key);
  }

  return issues;
}

/** 保存/预览入口共用：有问题直接拼成一句话拒绝，问题列表放在 details 里可逐条展示 */
export function assertValidTiming(timing: TimingDto): void {
  const issues = validateTiming(timing);
  if (issues.length > 0) {
    const err = new Error(issues.map((i) => i.message).join('；')) as Error & { issues?: TimingIssue[] };
    err.name = 'InvalidTiming';
    err.issues = issues;
    throw err;
  }
}
