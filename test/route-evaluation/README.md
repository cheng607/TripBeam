# 路线方案对比评测集

`cases.json` 包含 20 组固定输入，覆盖城市、时段、时长、标准偏好和组合型自由偏好。所有对比必须在同一时间窗口、同一高德数据源和同一输入下运行。

每个 case 分别保存两组结果：

- `current`：当前 `generateItinerary` 生成的服务端验证路线；
- `dify`：Dify 提案经地点消歧、路网重算和约束校验后的路线。不得把未经核验的 Dify 文本作为对比结果。

将 `comparison-results.template.json` 复制为 `comparison-results.json` 后，每项按如下格式填写：

```json
{
  "caseId": "C01-shanghai-food-bookstore",
  "current": { "routeIds": ["..."], "titles": ["..."], "status": "complete" },
  "dify": { "routeIds": ["..."], "titles": ["..."], "status": "complete", "replacedPoiCount": 0 },
  "review": {
    "currentFit": 3,
    "difyFit": 5,
    "winner": "dify",
    "notes": "Dify 更好地回应了独立书店与少走路的组合偏好。"
  }
}
```

人工评分使用 1–5 分：5 为准确回应全部关键偏好且路线主题自然；3 为满足标准偏好但忽略部分自由偏好；1 为明显偏题或违反排除条件。自动验收条件是两组正式路线都必须通过地图、8km 和时长校验。

当前环境未配置 `DIFY_API_KEY`，因此模板刻意保持 `dify: null`；这避免将不存在的 Dify 结果当作评测证据。
