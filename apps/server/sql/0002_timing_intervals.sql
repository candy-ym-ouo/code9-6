-- 时间锚支持多段允许区间：每段独立锚点/偏移/仰角/方位角，段之间为「或」。
-- 旧数据的 intervals 由服务端在读取时从顶层字段合成（向后兼容，无需回填）。
ALTER TABLE timing ADD COLUMN intervals TEXT;
