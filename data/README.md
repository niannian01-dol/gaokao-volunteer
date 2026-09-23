数据文件已经移到 `public/data/`（静态托管时能直接被前端读取）：

- `public/data/admission.json`       录取记录
- `public/data/score-segments.json`  一分一段表
- `public/data/meta.json`            筛选器选项

重新生成：`node scripts/build-data.mjs`
