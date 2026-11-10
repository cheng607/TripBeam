# TripBeam

> 面向城市短时探索的智能路线规划应用。

[在线体验](https://www.raincode.top/tripBeam/) · [接口契约](docs/openapi.yaml) · [技术架构](docs/arch.md) · [体验与验收](docs/product-agent-experience.md)

TripBeam 面向“此刻有两三个小时，想在附近好好逛一逛”的场景。用户用自然语言描述出发位置、时间和偏好；系统只补问必要信息，再结合真实 POI 与路网数据，生成可比较、可编辑、可保存的城市短途路线。

## 核心能力

- **对话式需求澄清**：从一句自然语言开始，仅针对缺失的出发点、时间、时长、兴趣或交通方式继续提问。
- **真实地图与路线数据**：后端通过高德 Web 服务完成地点解析、POI 检索和路网计算；前端使用高德 JS API 呈现底图、标记和路线几何。
- **多方案对比**：围绕不同体验策略生成可比较路线，展示时间、距离、停靠点、推荐依据与注意事项。
- **可校验的路线编辑**：支持添加、删除、替换、排序和自然语言编辑。每次变更均在服务端重新计算时间、距离与约束状态。
- **会话与分享**：匿名会话可在当前浏览器标签页恢复；有效路线可保存并生成不可变分享快照。

## 设计原则

TripBeam 将“理解用户意图”和“计算路线事实”严格分开：

- LLM 只用于提取用户明确表达的偏好、生成补问及撰写基于已验证事实的说明。
- 距离、时长、路线顺序、约束判定与版本控制均由确定性 TypeScript 服务和地图服务完成。
- 地图或模型服务不可用时，系统会明确告知降级状态，不会虚构地点、路径或实时信息。

因此，页面中的路线时间是基于路网时长、建议停留与缓冲时间的规划估计；营业状态、排队、预约和现场变化仍应以实际情况为准。

## 技术栈

| 层级 | 技术与职责 |
| --- | --- |
| 前端 | React、Vite、TypeScript、TanStack Query；负责对话、路线对比、编辑和分享界面 |
| 地图 | 高德 JS API（前端展示）与高德 Web 服务（地点、POI、路网） |
| 服务端 | Fastify、Zod、TypeScript；负责会话、约束校验、路线编辑与 REST API |
| 规划器 | 确定性候选筛选、差异化组路、路网重算与版本控制 |
| 存储 | 开发环境使用文件存储；生产环境使用 PostgreSQL |
| 模型 | DeepSeek（默认）或 Dify Workflow（可选），仅处理受限的意图与文案任务 |
| 部署 | Docker Compose、Nginx；提供宝塔面板部署示例 |

## 快速开始

### 前置条件

- Node.js 22+
- pnpm 11+
- 高德 Web 服务 Key（后端）
- 高德 Web 端 JS API Key（前端地图）
- DeepSeek API Key 或 Dify Workflow（可选，但建议配置）

安装依赖：

```bash
pnpm install
```

复制环境变量模板并填写本地凭据：

```bash
copy apps\api\.env.example apps\api\.env
copy apps\web\.env.example apps\web\.env
```

启动前后端：

```bash
pnpm dev
```

默认地址：

- Web：`http://localhost:4173/`
- API：`http://127.0.0.1:3101/health`

### 本地环境变量

`apps/api/.env` 至少配置：

```ini
AMAP_WEB_KEY=高德_Web服务_Key
DEEPSEEK_API_KEY=DeepSeek_API_Key
DEMO_MAP=false
```

`apps/web/.env` 配置浏览器侧地图 Key：

```ini
VITE_API_BASE_URL=http://127.0.0.1:3101
VITE_AMAP_JS_KEY=高德_Web端_JS_API_Key
VITE_AMAP_SECURITY_JS_CODE=高德安全密钥（如控制台启用）
```

`AMAP_WEB_KEY` 和 `VITE_AMAP_JS_KEY` 必须使用**两个不同的 Key**。前者只能留在服务端；后者会被编译进浏览器资源，应在高德控制台限制可用域名。

## 宝塔 / Docker 部署

仓库提供 `deploy/baota-compose.yml`，适用于通过宝塔反向代理部署到子路径，例如：`https://www.raincode.top/tripBeam/`。

1. 克隆仓库后，在服务器创建 `deploy/.env`：

   ```ini
   DOMAIN=www.raincode.top
   TRIPBEAM_BASE_PATH=/tripBeam

   POSTGRES_PASSWORD=请使用强随机密码
   PLANNER_INTERNAL_TOKEN=请使用强随机值

   AMAP_WEB_KEY=高德_Web服务_Key
   DEEPSEEK_API_KEY=DeepSeek_API_Key
   VITE_AMAP_JS_KEY=高德_Web端_JS_API_Key
   VITE_AMAP_SECURITY_JS_CODE=高德安全密钥（如需）
   ```

   完整字段见 [`deploy/production.env.example`](deploy/production.env.example)。不要将真实 `.env` 提交到仓库。

2. 在宝塔站点的 Nginx 配置中，将 `/tripBeam/` 反向代理到 `127.0.0.1:18080`。容器内部会将 `/v1/`、`/health`、`/ready` 转发给 API。

3. 构建并启动：

   ```bash
   cd /www/wwwroot/tripbeam/deploy
   docker compose --env-file .env -f baota-compose.yml up -d --build
   curl http://127.0.0.1:18080/ready
   ```

返回 `{"status":"ready"}` 后再接入反向代理。前端地图 Key 属于构建变量，修改 `VITE_AMAP_*` 后必须执行一次 `up -d --build`。

> PostgreSQL 数据保存在 Docker 卷 `tripbeam_pg`。日常更新不要使用 `docker compose down -v`，否则会删除数据库卷。

## 验证与质量检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

自动化测试使用隔离的地图与模型替身，不会消耗真实高德或模型 API 配额。真实服务联调可运行：

```bash
pnpm smoke:real
```

## 项目结构

```text
apps/
  api/          Fastify API、地图适配、路线规划与存储
  web/          React 前端与高德地图渲染
packages/
  contracts/    前后端共享 Zod Schema 与类型
deploy/         Docker Compose、Nginx 与生产环境变量模板
docs/           产品、架构、策略、接口与验收文档
test/           E2E 与路线评估测试
```

## API 与文档

主要端点包括：

- `POST /v1/sessions`、`GET /v1/sessions/{id}`、`POST /v1/sessions/{id}/turns`
- `POST /v1/itineraries/generate`、`GET /v1/itineraries/{id}`
- `POST /v1/itineraries/{id}/routes/{routeId}/edits`
- `POST /v1/itineraries/{id}/save`、`POST /v1/itineraries/{id}/share`
- `GET /v1/shares/{token}`

完整请求与响应定义见 [`docs/openapi.yaml`](docs/openapi.yaml)。更多设计细节见：

- [技术架构](docs/arch.md)
- [路线体验策略](docs/experience-planning-v2.md)
- [产品体验说明](docs/product-agent-experience.md)
- [质量验收记录](docs/agent-qa.md)

## 已知边界

- 当前聚焦单城、单日、30–240 分钟的短时出行。
- 不提供实时营业、实时客流、预约、预算金额、多日行程或用户账户体系。
- 当前为个人/受控环境的匿名服务；若面向公网多用户，请在网关层补充身份认证、访问控制、WAF、日志脱敏、监控与数据库备份策略。

## 安全说明

- 不要提交 `.env`、真实 API Key、数据库密码或会话令牌。
- `AMAP_WEB_KEY`、`DEEPSEEK_API_KEY`、`POSTGRES_PASSWORD` 与 `PLANNER_INTERNAL_TOKEN` 只能配置在服务端。
- `VITE_AMAP_JS_KEY` 会出现在浏览器中，必须设置域名白名单；不要复用服务端 Key。
