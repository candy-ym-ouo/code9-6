import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import type { AzimuthArc, ClockInterval, TimingDto, TimeAnchor } from '@flil/shared';
import { useMeta, usePreviewTiming, useSaveTiming } from '../api/hooks.js';

interface Props {
  inspirationId: string;
  initial: TimingDto | null;
  /** 机位朝向，用于把光位角换算成期望太阳方位角 */
  cameraBearing: number | null;
  /** 最近一次标注得到的光位角（如果用户画了光位箭头） */
  lightBearingHint?: number | null;
  onSaved?: () => void;
}

const DEFAULT_TIMING: TimingDto = {
  timeAnchor: 'sunset_minus',
  anchorOffsetMin: 40,
  elevationRange: [-4, 10],
  azimuthRange: null,
  azimuthArcs: [],
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  allowedIntervals: [],
  weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 20, max: 60 }, hardRequirements: ['precipProbPctMax'] },
  seasonWindow: null,
  notes: null,
};

/** 0..1439 分钟 ↔ "HH:MM" */
function minuteToText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function textToMinute(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function normDeg(v: number): number {
  return (((v % 360) + 360) % 360);
}

export function TimingEditor({ inspirationId, initial, cameraBearing, lightBearingHint, onSaved }: Props) {
  const { data: meta } = useMeta();
  const [timing, setTiming] = useState<TimingDto>(initial ?? DEFAULT_TIMING);
  const [useAzimuth, setUseAzimuth] = useState(Boolean(initial?.azimuthRange || (initial?.azimuthArcs?.length ?? 0) > 0));
  const preview = usePreviewTiming();
  const save = useSaveTiming();

  useEffect(() => {
    if (initial) {
      setTiming(initial);
      setUseAzimuth(Boolean(initial.azimuthRange || initial.azimuthArcs.length > 0));
    }
  }, [initial]);

  const expectedAzimuth = useMemo(() => {
    if (cameraBearing === null || lightBearingHint === null || lightBearingHint === undefined) return null;
    return Math.round((((cameraBearing + lightBearingHint) % 360) + 360) % 360);
  }, [cameraBearing, lightBearingHint]);

  function patchTiming(patch: Partial<TimingDto>) {
    setTiming((t) => ({ ...t, ...patch }));
  }

  function patchIntervals(i: number, patch: Partial<ClockInterval>) {
    setTiming((t) => ({
      ...t,
      allowedIntervals: t.allowedIntervals.map((iv, j) => (j === i ? { ...iv, ...patch } : iv)),
    }));
  }

  function patchArc(i: number, patch: Partial<AzimuthArc>) {
    setTiming((t) => ({
      ...t,
      azimuthArcs: t.azimuthArcs.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    }));
  }

  /** 提交前把未启用的约束清空，并把"结束=开始"等本地明显非法值提前拦下 */
  function buildPayload(): TimingDto | string {
    const payload: TimingDto = {
      ...timing,
      azimuthRange: useAzimuth ? timing.azimuthRange : null,
      azimuthArcs: useAzimuth ? timing.azimuthArcs : [],
    };
    if (useAzimuth) {
      for (const arc of payload.azimuthArcs) {
        if (arc.startDeg === arc.endDeg) {
          return `方位弧零宽（${arc.startDeg}°→${arc.endDeg}°）不含任何方向，请修改或删除该段`;
        }
      }
      if (payload.azimuthRange && payload.azimuthArcs.length > 0) {
        return '不能同时使用方位中心和多段方位弧';
      }
    }
    for (const iv of payload.allowedIntervals) {
      if (iv.endMin === iv.startMin) {
        return '允许区间不能为零长度（起止钟点相同）';
      }
    }
    return payload;
  }

  function patchWeather(patch: Record<string, unknown>) {
    setTiming((t) => ({ ...t, weatherProfile: { ...t.weatherProfile, ...patch } }));
  }

  function applyPreset(key: string) {
    const preset = meta?.weatherPresets.find((p) => p.key === key);
    if (preset) patchTiming({ weatherProfile: preset.profile as TimingDto['weatherProfile'] });
  }

  async function runPreview() {
    const payload = buildPayload();
    if (typeof payload === 'string') {
      message.error(payload);
      return null;
    }
    try {
      const res = await preview.mutateAsync({ id: inspirationId, timing: payload });
      message.success('已按今天的数据试算');
      return res;
    } catch (err) {
      message.error((err as Error).message);
      return null;
    }
  }

  async function onSave() {
    const payload = buildPayload();
    if (typeof payload === 'string') {
      message.error(payload);
      return;
    }
    try {
      const res = await save.mutateAsync({ id: inspirationId, timing: payload });
      const good = res.windows.filter((w) => w.verdict === 'good').length;
      message.success(`已保存，并重算了 7 天窗口（其中 ${good} 天可拍）`);
      onSaved?.();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  const p = preview.data;

  return (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card size="small" title="① 时间锚（用太阳事件定义，而不是钟点）" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Select
              style={{ width: '100%' }}
              value={timing.timeAnchor}
              onChange={(v: TimeAnchor) => patchTiming({ timeAnchor: v })}
              options={(meta?.timeAnchors ?? []).map((a) => ({ value: a.key, label: a.label }))}
            />
            {timing.timeAnchor === 'sunset_minus' ||
            timing.timeAnchor === 'sunrise_plus' ||
            timing.timeAnchor === 'fixed_clock' ? (
              <Space>
                <Typography.Text type="secondary">
                  {timing.timeAnchor === 'fixed_clock' ? '钟点（分钟数）' : '偏移（分钟）'}
                </Typography.Text>
                <InputNumber
                  min={timing.timeAnchor === 'fixed_clock' ? 0 : 0}
                  max={timing.timeAnchor === 'fixed_clock' ? 1439 : 240}
                  value={timing.anchorOffsetMin}
                  onChange={(v) => patchTiming({ anchorOffsetMin: Number(v ?? 0) })}
                />
              </Space>
            ) : null}
            <Space>
              <Typography.Text type="secondary">窗口容差 ±（分钟）</Typography.Text>
              <InputNumber
                min={1}
                max={180}
                value={timing.windowToleranceMin}
                onChange={(v) => patchTiming({ windowToleranceMin: Number(v ?? 12) })}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （未指定允许区间时生效）
              </Typography.Text>
            </Space>
            <Space>
              <Typography.Text type="secondary">季节窗口</Typography.Text>
              <Select
                style={{ width: 220 }}
                value={timing.seasonWindow ? 'custom' : 'none'}
                onChange={(v) =>
                  patchTiming({ seasonWindow: v === 'none' ? null : { fromMonth: 9, toMonth: 3 } })
                }
                options={[
                  { value: 'none', label: '全年' },
                  { value: 'custom', label: '9 月 – 次年 3 月' },
                ]}
              />
            </Space>
          </Space>
        </Card>

        <Card
          size="small"
          title="①b 多段允许区间（机位本地钟点，可跨午夜；留空=沿用锚点窗口）"
          style={{ marginBottom: 12 }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {timing.allowedIntervals.map((iv, i) => {
              const wraps = iv.endMin <= iv.startMin;
              return (
                <Space key={`iv-${i}-${iv.startMin}-${iv.endMin}`} align="center" wrap>
                  <Typography.Text type="secondary">第 {i + 1} 段</Typography.Text>
                  <Input
                    style={{ width: 90 }}
                    defaultValue={minuteToText(iv.startMin)}
                    placeholder="23:00"
                    onBlur={(e) => {
                      const v = textToMinute(e.target.value);
                      if (v === null) return message.error('开始钟点格式应为 HH:MM（00:00–23:59）');
                      patchIntervals(i, { startMin: v });
                    }}
                  />
                  <Typography.Text>–</Typography.Text>
                  <Input
                    style={{ width: 90 }}
                    defaultValue={minuteToText(iv.endMin === 1440 ? 0 : iv.endMin)}
                    placeholder="01:00"
                    onBlur={(e) => {
                      const v = textToMinute(e.target.value);
                      if (v === null) return message.error('结束钟点格式应为 HH:MM（00:00–23:59）');
                      // 00:00 作为结束值时存为 1440（次日零点），语义无零宽歧义
                      patchIntervals(i, { endMin: v === 0 && iv.startMin > 0 ? 1440 : v });
                    }}
                  />
                  {wraps ? (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      跨午夜：{minuteToText(iv.startMin)} → 次日 {minuteToText(iv.endMin)}
                    </Typography.Text>
                  ) : null}
                  <Button
                    size="small"
                    danger
                    onClick={() =>
                      patchTiming({ allowedIntervals: timing.allowedIntervals.filter((_, j) => j !== i) })
                    }
                  >
                    删除
                  </Button>
                </Space>
              );
            })}
            <Space>
              <Button
                size="small"
                disabled={timing.allowedIntervals.length >= 6}
                onClick={() =>
                  patchTiming({
                    allowedIntervals: [...timing.allowedIntervals, { startMin: 23 * 60, endMin: 1440 }],
                  })
                }
              >
                + 添加允许区间
              </Button>
              {timing.allowedIntervals.length > 0 ? (
                <Button size="small" onClick={() => patchTiming({ allowedIntervals: [] })}>
                  清空（沿用锚点窗口）
                </Button>
              ) : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              结束钟点不晚于开始钟点即视为跨午夜。例如 23:00–01:00
              会判定"当天 23:00 起、到次日 01:00 止"这一整段；预览与每日窗口判定使用同一算法。
            </Typography.Text>
          </Space>
        </Card>

        <Card size="small" title="② 光位（可复现的关键）" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Switch checked={useAzimuth} onChange={setUseAzimuth} />
              <Typography.Text>约束太阳方位角</Typography.Text>
              {useAzimuth ? (
                <Select
                  size="small"
                  style={{ width: 170 }}
                  value={timing.azimuthArcs.length > 0 ? 'arcs' : 'center'}
                  onChange={(v) => {
                    if (v === 'arcs') {
                      patchTiming({
                        azimuthRange: null,
                        azimuthArcs: timing.azimuthArcs.length ? timing.azimuthArcs : [{ startDeg: 350, endDeg: 10 }],
                      });
                    } else {
                      patchTiming({ azimuthRange: [265, 265], azimuthArcs: [] });
                    }
                  }}
                  options={[
                    { value: 'center', label: '单一中心 ± 容差' },
                    { value: 'arcs', label: '多段方位弧（可跨正北）' },
                  ]}
                />
              ) : null}
            </Space>
            {useAzimuth ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  期望方位角 = 拍摄朝向（{cameraBearing ?? '未设置'}°）+ 光位角。
                  {expectedAzimuth !== null
                    ? ` 根据你画的光位箭头 ${Math.round(lightBearingHint!)}°，系统建议 ${expectedAzimuth}°±${timing.azimuthTolerance}°。`
                    : ' 还没有光位标注时，可以手动填方位角。'}
                </Typography.Text>
                {timing.azimuthArcs.length > 0 ? (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {timing.azimuthArcs.map((arc, i) => {
                      const wraps = arc.endDeg <= arc.startDeg;
                      return (
                        <Space key={i} wrap>
                          <Typography.Text type="secondary">弧 {i + 1}：从</Typography.Text>
                          <InputNumber
                            min={0}
                            max={360}
                            value={arc.startDeg}
                            onChange={(v) => patchArc(i, { startDeg: Number(v ?? 0) })}
                          />
                          <Typography.Text>顺时针到</Typography.Text>
                          <InputNumber
                            min={0}
                            max={360}
                            value={arc.endDeg}
                            onChange={(v) => patchArc(i, { endDeg: Number(v ?? 0) })}
                          />
                          {wraps ? (
                            <Typography.Text type="warning" style={{ fontSize: 12 }}>
                              跨正北：{normDeg(arc.startDeg).toFixed(0)}° → {arc.endDeg.toFixed(0)}°（顺时针绕过 0°）
                            </Typography.Text>
                          ) : (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              张角 {(arc.endDeg - arc.startDeg).toFixed(0)}°
                            </Typography.Text>
                          )}
                          <Button
                            size="small"
                            danger
                            onClick={() =>
                              patchTiming({ azimuthArcs: timing.azimuthArcs.filter((_, j) => j !== i) })
                            }
                          >
                            删除
                          </Button>
                        </Space>
                      );
                    })}
                    <Space>
                      <Button
                        size="small"
                        disabled={timing.azimuthArcs.length >= 6}
                        onClick={() =>
                          patchTiming({
                            azimuthArcs: [...timing.azimuthArcs, { startDeg: 350, endDeg: 10 }],
                          })
                        }
                      >
                        + 添加方位弧
                      </Button>
                      {expectedAzimuth !== null ? (
                        <Button
                          size="small"
                          onClick={() =>
                            patchTiming({
                              azimuthArcs: [
                                {
                                  startDeg: normDeg(expectedAzimuth - timing.azimuthTolerance),
                                  endDeg: normDeg(expectedAzimuth + timing.azimuthTolerance),
                                },
                              ],
                            })
                          }
                        >
                          用光位建议生成（{expectedAzimuth}°±{timing.azimuthTolerance}°）
                        </Button>
                      ) : null}
                    </Space>
                  </Space>
                ) : (
                  <Space>
                    <Typography.Text type="secondary">方位角中心</Typography.Text>
                    <InputNumber
                      min={0}
                      max={360}
                      value={timing.azimuthRange?.[0] ?? 265}
                      onChange={(v) => {
                        const center = Number(v ?? 265);
                        patchTiming({ azimuthRange: [center, center] });
                      }}
                    />
                    <Typography.Text type="secondary">容差 ±{timing.azimuthTolerance}°</Typography.Text>
                    <Slider
                      style={{ width: 140 }}
                      min={5}
                      max={45}
                      value={timing.azimuthTolerance}
                      onChange={(v) => patchTiming({ azimuthTolerance: v })}
                    />
                  </Space>
                )}
              </>
            ) : (
              <Typography.Text type="secondary">不约束光位：任何太阳方位角都算命中。</Typography.Text>
            )}
          </Space>
        </Card>

        <Card size="small" title="③ 天气画像" style={{ marginBottom: 12 }}>
          <Space wrap style={{ marginBottom: 10 }}>
            {(meta?.weatherPresets ?? []).map((preset) => (
              <Button key={preset.key} size="small" onClick={() => applyPreset(preset.key)} title={preset.description}>
                {preset.name}
              </Button>
            ))}
          </Space>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Typography.Text type="secondary">云量区间 %</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.min ?? 0}
                onChange={(v) =>
                  patchWeather({ cloudCoverPct: { min: Number(v ?? 0), max: timing.weatherProfile.cloudCoverPct?.max ?? 100 } })
                }
              />
              <Typography.Text>–</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.cloudCoverPct?.max ?? 100}
                onChange={(v) =>
                  patchWeather({ cloudCoverPct: { min: timing.weatherProfile.cloudCoverPct?.min ?? 0, max: Number(v ?? 100) } })
                }
              />
            </Space>
            <Space>
              <Typography.Text type="secondary">降水概率上限 %</Typography.Text>
              <InputNumber
                min={0}
                max={100}
                value={timing.weatherProfile.precipProbPctMax ?? 20}
                onChange={(v) => patchWeather({ precipProbPctMax: Number(v ?? 20) })}
              />
              <Typography.Text type="secondary">（默认按硬性项处理：超出即判"不可拍"）</Typography.Text>
            </Space>
            <Space>
              <Typography.Text type="secondary">能见度下限 km</Typography.Text>
              <InputNumber
                min={0}
                max={50}
                value={timing.weatherProfile.visibilityKmMin ?? 8}
                onChange={(v) => patchWeather({ visibilityKmMin: Number(v ?? 8) })}
              />
              <Typography.Text type="secondary">风速上限 m/s</Typography.Text>
              <InputNumber
                min={0}
                max={40}
                value={timing.weatherProfile.windSpeedMax ?? 8}
                onChange={(v) => patchWeather({ windSpeedMax: Number(v ?? 8) })}
              />
            </Space>
          </Space>
        </Card>

        <Space>
          <Button type="primary" loading={save.isPending} onClick={onSave}>
            保存并重算窗口
          </Button>
          <Button loading={preview.isPending} onClick={runPreview}>
            用今天的数据试算
          </Button>
        </Space>
      </Col>

      <Col xs={24} lg={10}>
        <Card size="small" title="今天的锚点长什么样" style={{ marginBottom: 12 }}>
          {p ? (
            <>
              <Descriptions column={1} size="small">
                <Descriptions.Item label="锚点时刻">
                  {p.anchorLocal ?? '该日无解'}
                  {p.polarity && p.polarity !== 'none' ? (
                    <Tag color="orange" style={{ marginLeft: 8 }}>
                      {p.polarity === 'midnight_sun' ? '极昼' : '极夜'}
                    </Tag>
                  ) : null}
                </Descriptions.Item>
                <Descriptions.Item label="日出 / 日落">
                  {p.sunEvents.sunrise ?? '—'} / {p.sunEvents.sunset ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="黄金时刻（昏）">{p.sunEvents.goldenPm ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="蓝调时刻（昏）">{p.sunEvents.bluePm ?? '—'}</Descriptions.Item>
              </Descriptions>
              {p.segments.length ? (
                <div style={{ marginTop: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    当日各允许区间试算（跨午夜段按实际日期展开）：
                  </Typography.Text>
                  {p.segments.map((s, i) => (
                    <div key={i} style={{ marginTop: 6 }}>
                      <Space wrap>
                        <Tag color={s.verdict === 'good' ? 'green' : s.verdict === 'marginal' ? 'gold' : 'red'}>
                          {s.verdict === 'good' ? '可成立' : s.verdict === 'marginal' ? '勉强' : '不成立'}
                        </Tag>
                        <Typography.Text style={{ fontSize: 12 }}>
                          {s.label || '锚点窗口'}：{s.startLocal} – {s.endLocal}
                        </Typography.Text>
                        {s.windowLocal ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            实际窗口 {s.windowLocal}（约 {s.durationMin} 分钟）
                          </Typography.Text>
                        ) : null}
                      </Space>
                      {s.reasons.map((r, j) => (
                        <div key={j}>
                          <Typography.Text
                            type={r.level === 'bad' ? 'danger' : r.level === 'warn' ? 'warning' : 'secondary'}
                            style={{ fontSize: 12 }}
                          >
                            · {r.text}
                          </Typography.Text>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
              {p.notes.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {p.notes.join('；')}
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Typography.Text type="secondary">点"用今天的数据试算"，看看这个锚点对应今天几点。</Typography.Text>
          )}
        </Card>

        <Card size="small" title="可满足性检查（避免设出永远不成立的严条件）">
          {p ? (
            <>
              <Space size="large">
                <Statistic title={`未来 ${p.satisfiability.total} 天可能成立`} value={p.satisfiability.satisfied} />
                <Statistic title="比例" value={(p.satisfiability.ratio * 100).toFixed(0)} suffix="%" />
              </Space>
              <Divider style={{ margin: '12px 0' }} />
              {p.satisfiability.advice ? (
                <Alert
                  type={p.satisfiability.satisfied === 0 ? 'warning' : 'info'}
                  showIcon
                  message={p.satisfiability.advice}
                />
              ) : (
                <Alert type="success" showIcon message="条件可满足性正常，未来 7 天有可拍机会。" />
              )}
            </>
          ) : (
            <Typography.Text type="secondary">先试算一次，再看建议。</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}
