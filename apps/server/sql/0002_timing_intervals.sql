-- 时间锚：多段允许钟点区间（可跨午夜）与多段方位角圆弧（可跨正北）
-- 旧数据默认空数组/空 JSON，语义退化为原来的"锚点窗口 ± 容差"与 azimuthRange 单中心。
ALTER TABLE timing ADD COLUMN allowed_intervals TEXT NOT NULL DEFAULT '[]';
ALTER TABLE timing ADD COLUMN azimuth_arcs TEXT NOT NULL DEFAULT '[]';
