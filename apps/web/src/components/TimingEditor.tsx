import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
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
import type { TimingDto, TimingInterval, TimeAnchor } from '@flil/shared';
import { useMeta, usePreviewTiming, useSaveTiming } from '../api/hooks.js';
import type { PreviewInterval } from '../api/hooks.js';

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
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 20, max: 60 }, hardRequirements: ['precipProbPctMax'] },
  seasonWindow: null,
  notes: null,
};

function makeInterval(i: Partial<TimingInterval> = {}): TimingInterval {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    label: null,
    ...i,
  };
}

/** 后端返回的 timing 一定带 intervals；旧数据兜底一次。 */
function toIntervals(timing: TimingDto): TimingInterval[] {
  if (Array.isArray(timing.intervals) && timing.intervals.length > 0) return timing.intervals;
  return [
    {
      timeAnchor: timing.timeAnchor,
      anchorOffsetMin: timing.anchorOffsetMin,
      elevationRange: timing.elevationRange,
      azimuthRange: timing.azimuthRange,
      azimuthTolerance: timing.azimuthTolerance,
      windowToleranceMin: timing.windowToleranceMin,
      label: null,
    },
  ];
}

const STATUS_META: Record<PreviewInterval['status'], { color: string; text: string }> = {
  ok: { color: 'success', text: '可成立' },
  anchor_unresolved: { color: 'error', text: '锚点无解（极昼/极夜）' },
  elevation_miss: { color: 'error', text: '仰角不满足' },
  azimuth_miss: { color: 'error', text: '方位角不满足' },
};

export function TimingEditor({ inspirationId, initial, cameraBearing, lightBearingHint, onSaved }: Props) {
  const { data: meta } = useMeta();
  const seed = initial ?? DEFAULT_TIMING;
  const [timing, setTiming] = useState<TimingDto>(seed);
  const [intervals, setIntervals] = useState<TimingInterval[]>(() => toIntervals(seed));
  const preview = usePreviewTiming();
  const save = useSaveTiming();

  useEffect(() => {
    if (initial) {
      setTiming(initial);
      setIntervals(toIntervals(initial));
    }
  }, [initial]);

  const expectedAzimuth = useMemo(() => {
    if (cameraBearing === null || lightBearingHint === null || lightBearingHint === undefined) return null;
    return Math.round((((cameraBearing + lightBearingHint) % 360) + 360) % 360);
  }, [cameraBearing, lightBearingHint]);

  function patchWeather(patch: Record<string, unknown>) {
    setTiming((t) => ({ ...t, weatherProfile: { ...t.weatherProfile, ...patch } }));
  }

  function patchInterval(idx: number, patch: Partial<TimingInterval>) {
    setIntervals((list) => list.map((iv, i) => (i === idx ? { ...iv, ...patch } : iv)));
  }

  function buildPayload(): TimingDto {
    const first = intervals[0];
    return {
      ...timing,
      intervals,
      // 顶层字段镜像第一段（旧读取方与 DB 顶层列兼容）
      timeAnchor: first.timeAnchor,
      anchorOffsetMin: first.anchorOffsetMin,
      elevationRange: first.elevationRange,
      azimuthRange: first.azimuthRange,
      azimuthTolerance: first.azimuthTolerance,
      windowToleranceMin: first.windowToleranceMin,
    };
  }

  function applyPreset(key: string) {
    const preset = meta?.weatherPresets.find((p) => p.key === key);
    if (preset) setTiming((t) => ({ ...t, weatherProfile: preset.profile as TimingDto['weatherProfile'] }));
  }

  async function runPreview() {
    try {
      const res = await preview.mutateAsync({ id: inspirationId, timing: buildPayload() });
      message.success('已按今天的数据试算');
      return res;
    } catch (err) {
      message.error((err as Error).message);
      return null;
    }
  }

  async function onSave() {
    try {
      const res = await save.mutateAsync({ id: inspirationId, timing: buildPayload() });
      const good = res.windows.filter((w) => w.verdict === 'good').length;
      message.success(`已保存，并重算了 7 天窗口（其中 ${good} 天可拍）`);
      onSaved?.();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  const p = preview.data;
  const previewByIndex = new Map((p?.intervals ?? []).map((iv) => [iv.index, iv]));

  return (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card
          size="small"
          title="① 允许时段（多个时段为「或」：任一成立即可拍）"
          style={{ marginBottom: 12 }}
          extra={
            <Space>
              <Button
                size="small"
                disabled={intervals.length >= 6}
                onClick={() =>
                  setIntervals((list) => [...list, makeInterval({ label: `时段 ${list.length + 1}` })])
                }
              >
                增加时段
              </Button>
              {intervals.length > 1 ? (
                <Button size="small" danger onClick={() => setIntervals((list) => list.slice(0, -1))}>
                  删除最后一段
                </Button>
              ) : null}
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            {intervals.map((iv, idx) => {
              const useAz = iv.azimuthRange !== null;
              const pre = previewByIndex.get(idx);
              return (
                <Card
                  key={idx}
                  size="small"
                  type="inner"
                  title={
                    <Space wrap>
                      <Tag>第 {idx + 1} 段</Tag>
                      {pre ? <Tag color={STATUS_META[pre.status].color}>{STATUS_META[pre.status].text}</Tag> : null}
                      {pre?.band?.crossesMidnight ? <Tag color="processing">跨午夜</Tag> : null}
                    </Space>
                  }
                >
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    <Space wrap>
                      <Typography.Text type="secondary">时间锚</Typography.Text>
                      <Select
                        style={{ width: 200 }}
                        value={iv.timeAnchor}
                        onChange={(v: TimeAnchor) => patchInterval(idx, { timeAnchor: v })}
                        options={(meta?.timeAnchors ?? []).map((a) => ({ value: a.key, label: a.label }))}
                      />
                      {iv.timeAnchor === 'sunset_minus' ||
                      iv.timeAnchor === 'sunrise_plus' ||
                      iv.timeAnchor === 'fixed_clock' ? (
                        <>
                          <Typography.Text type="secondary">
                            {iv.timeAnchor === 'fixed_clock' ? '钟点（分钟数）' : '偏移（分钟）'}
                          </Typography.Text>
                          <InputNumber
                            min={0}
                            max={iv.timeAnchor === 'fixed_clock' ? 1439 : 240}
                            value={iv.anchorOffsetMin}
                            onChange={(v) => patchInterval(idx, { anchorOffsetMin: Number(v ?? 0) })}
                          />
                        </>
                      ) : null}
                      <Typography.Text type="secondary">窗口容差 ±分</Typography.Text>
                      <InputNumber
                        min={1}
                        max={180}
                        value={iv.windowToleranceMin}
                        onChange={(v) => patchInterval(idx, { windowToleranceMin: Number(v ?? 12) })}
                      />
                    </Space>

                    <Space wrap>
                      <Typography.Text type="secondary">仰角区间 °</Typography.Text>
                      <InputNumber
                        min={-90}
                        max={90}
                        value={iv.elevationRange[0]}
                        onChange={(v) => patchInterval(idx, { elevationRange: [Number(v ?? -90), iv.elevationRange[1]] })}
                      />
                      <Typography.Text>–</Typography.Text>
                      <InputNumber
                        min={-90}
                        max={90}
                        value={iv.elevationRange[1]}
                        onChange={(v) => patchInterval(idx, { elevationRange: [iv.elevationRange[0], Number(v ?? 90)] })}
                      />
                      {iv.elevationRange[1] < iv.elevationRange[0] ? (
                        <Typography.Text type="danger" style={{ fontSize: 12 }}>
                          上界不能小于下界
                        </Typography.Text>
                      ) : null}
                    </Space>

                    <Space wrap>
                      <Switch
                        checked={useAz}
                        onChange={(on) =>
                          patchInterval(idx, {
                            azimuthRange: on ? [265, 265] : null,
                          })
                        }
                      />
                      <Typography.Text>约束太阳方位角</Typography.Text>
                    </Space>
                    {useAz ? (
                      <>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          方位角区间按「起点 顺时针走到 终点」解释，可跨过正北 0°/360°（如 350°→10°）；跨度超过
                          180° 会被拒绝。
                          {expectedAzimuth !== null
                            ? ` 你画的光位箭头对应建议方位角 ${expectedAzimuth}°。`
                            : ''}
                        </Typography.Text>
                        <Space wrap>
                          <Typography.Text type="secondary">起点 °</Typography.Text>
                          <InputNumber
                            min={0}
                            max={360}
                            value={iv.azimuthRange?.[0] ?? 265}
                            onChange={(v) =>
                              patchInterval(idx, { azimuthRange: [Number(v ?? 265), iv.azimuthRange?.[1] ?? 265] })
                            }
                          />
                          <Typography.Text type="secondary">终点 °（顺时针）</Typography.Text>
                          <InputNumber
                            min={0}
                            max={360}
                            value={iv.azimuthRange?.[1] ?? 265}
                            onChange={(v) =>
                              patchInterval(idx, { azimuthRange: [iv.azimuthRange?.[0] ?? 265, Number(v ?? 265)] })
                            }
                          />
                          <Typography.Text type="secondary">外扩容差 ±{iv.azimuthTolerance}°</Typography.Text>
                          <Slider
                            style={{ width: 120 }}
                            min={0}
                            max={45}
                            value={iv.azimuthTolerance}
                            onChange={(v) => patchInterval(idx, { azimuthTolerance: v })}
                          />
                        </Space>
                      </>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        不约束光位：任何太阳方位角都算命中。
                      </Typography.Text>
                    )}

                    {pre ? (
                      <Typography.Text
                        style={{ fontSize: 12 }}
                        type={pre.satisfiable ? 'success' : 'secondary'}
                      >
                        今日试算：{pre.anchorLocal ?? '无解'}
                        {pre.band ? `，窗口 ${pre.band.startLocal}–${pre.band.endLocal}` : ''}
                        ，锚点仰角 {pre.measured.anchorElevation?.toFixed(1) ?? '?'}°
                      </Typography.Text>
                    ) : null}
                  </Space>
                </Card>
              );
            })}
          </Space>
        </Card>

        <Card size="small" title="② 天气画像（全部时段共用）" style={{ marginBottom: 12 }}>
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
            <Space>
              <Typography.Text type="secondary">季节窗口</Typography.Text>
              <Select
                style={{ width: 220 }}
                value={timing.seasonWindow ? 'custom' : 'none'}
                onChange={(v) =>
                  setTiming((t) => ({
                    ...t,
                    seasonWindow: v === 'none' ? null : { fromMonth: 9, toMonth: 3 },
                  }))
                }
                options={[
                  { value: 'none', label: '全年' },
                  { value: 'custom', label: '9 月 – 次年 3 月' },
                ]}
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
        <Card size="small" title="今天各时段长什么样（与窗口判定同一套算法）" style={{ marginBottom: 12 }}>
          {p ? (
            <>
              <Descriptions column={1} size="small">
                <Descriptions.Item label="日出 / 日落">
                  {p.sunEvents.sunrise ?? '—'} / {p.sunEvents.sunset ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="极区状态">
                  {p.polarity === 'none' ? '正常昼夜' : p.polarity === 'midnight_sun' ? '极昼' : '极夜'}
                </Descriptions.Item>
              </Descriptions>
              <Divider style={{ margin: '12px 0' }} />
              {(p.intervals ?? []).map((iv) => (
                <div key={iv.index} style={{ marginBottom: 10 }}>
                  <Space wrap>
                    <Tag color={STATUS_META[iv.status].color}>第 {iv.index + 1} 段 · {STATUS_META[iv.status].text}</Tag>
                    {iv.band?.crossesMidnight ? <Tag color="processing">跨午夜</Tag> : null}
                  </Space>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {iv.anchor}：{iv.anchorLocal ?? '该日无解'}
                    {iv.band ? `（窗口 ${iv.band.startLocal}–${iv.band.endLocal}）` : ''}
                  </div>
                  {iv.notes.length ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {iv.notes.join('；')}
                    </Typography.Text>
                  ) : null}
                </div>
              ))}
              {p.notes.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {p.notes.join('；')}
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description='点"用今天的数据试算"，逐段看今天是否成立（含跨午夜与极昼/极夜）。'
            />
          )}
        </Card>

        <Card size="small" title="可满足性检查（避免设出永远不成立的严条件）">
          {p ? (
            <>
              <Space size="large">
                <Statistic title={`未来 ${p.satisfiability.total} 天至少一段成立`} value={p.satisfiability.satisfied} />
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
