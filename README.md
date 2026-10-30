# TripBeam

面向陌生城市短时出行的规划应用。React 页面通过 Fastify API 访问高德 Web 服务获取真实地点与路网几何；确定性 Planner 以时间预算、交通成本和体验策略发现候选，生成深度、漫游与轻松三类差异化路线并校验路网事实。DeepSeek 只提取用户明确表达的偏好，以及改写已验证路线的推荐理由，不能产生路线、距离、时间或合法性结论。

## 本地启动

要求 Node.js 22+、pnpm 11+。在项目根目录执行 `pnpm install`。**不要将 API Key 放入前端环境变量、提交到仓库或贴入聊天。已公开的密钥应先轮换。**

复制 `apps/api/.env.example` 为 `apps/api/.env`，在本机填写 `AMAP_WEB_KEY` 与轮换后的 `DEEPSEEK_API_KEY`。API 启动时自动读取 `apps/api/.env`；也可用部署环境变量注入。`DEEPSEEK_BASE_URL` 默认 `https://api.deepseek.com`，模型默认 `deepseek-chat`。前端可选复制 `apps/web/.env.example` 为 `apps/web/.env`，仅配置公开的 API 地址、底图 URL 与 attribution；**不要在 `VITE_*` 变量中放服务端密钥**。

```powershell
pnpm dev
```

浏览器打开 `http://localhost:4173/`，API 默认监听 `http://127.0.0.1:3101`。访问 `/health` 可检查地图和模型是否已配置，不会暴露密钥。若使用不同端口/域名，设置 `VITE_API_BASE_URL` 和 `WEB_ORIGIN`（允许多个源，以逗号分隔）。

本地默认使用 `apps/api/data/itineraries.json` 和 `apps/api/data/sessions.json`，适用于单进程开发。生产环境设置 `DATABASE_URL` 后改用 PostgreSQL，服务首次连接时创建行程、分享和会话表；编辑和分享使用事务及版本检查。未保存路线和匿名会话默认在 30 天无活动后清理（可用 `TRIPBEAM_DRAFT_TTL_DAYS` 调整）；“新的规划”会立刻删除当前会话及其未保存、未分享的路线。点过“保存路线”的行程和分享快照会保留。浏览器仅用当前标签页的 `sessionStorage` 暂存会话令牌和摘要。应由部署平台管理数据库凭据、TLS、备份、用户鉴权和访问控制。当前匿名 API 适合受控的 MVP 环境，**不要直接作为公开多用户服务上线**。

## 正式环境上线前检查

生产环境至少设置 `NODE_ENV=production`、`API_HOST=0.0.0.0`、`DATABASE_URL`、`WEB_ORIGIN`、`AMAP_WEB_KEY`、`PLANNER_INTERNAL_TOKEN`，并将 `DEMO_MAP=false`。启动后先检查 `/ready`，返回 `{"status":"ready"}` 才允许接入流量；`/health` 仅表示进程存活，不代表依赖已就绪。生产环境不要使用 OSM 公共瓦片，前端应配置符合服务条款的瓦片服务。部署示例见 `Dockerfile.api` 和 `docker-compose.prod.yml`。

本地 PostgreSQL 可使用 `docker-compose.local.yml`：先启动 Docker Desktop，再运行 `docker compose -f docker-compose.local.yml up -d`，然后在 `apps/api/.env` 设置 `DATABASE_URL=postgresql://tripbeam:tripbeam_local_change_me@127.0.0.1:5432/tripbeam`。API 首次连接会自动创建业务表；确认 `/health` 返回 `storageMode=postgres` 后，再运行 `pnpm smoke:real`。

当前仍需由部署方完成的外部事项：高德 Web 服务 Key 的域名/IP 白名单、配额与账单；DeepSeek 或 Dify 的正式 API Key、限流和账单；PostgreSQL 备份、TLS、监控告警；前端域名 HTTPS、反向代理和正式地图瓦片授权。项目已实现匿名 Session 令牌和接口限流，但尚未接入用户账户、团队权限、计费和审计系统；若面向公网多用户，需在网关增加身份认证和 WAF。

## 功能流程

1. 从一句自然语言或逐项选择开始，旅行助手提取偏好并补问缺失条件。支持 30 分钟至 4 小时；右侧出行摘要可直接修改。模型不可用时使用规则提取和结构化点选继续流程。
2. 后端按时间预算与用户允许的交通方式推导发现范围，查询真实 POI；以深度、漫游、轻松三种不同目标函数组路，并用高德路网查询每段时间、距离和 geometry，再由程序重新排期、校验。正常返回至少两条；不足时显式降级，完全无法满足时返回错误，不使用示意地图或虚构路线。
3. 对比页展示体验主线、时间、距离、步行强度、推荐依据及取舍。可继续询问推荐理由或按当前条件再找一组方案。地图叠加全部路线，当前路线高亮、其他路线淡化。
4. 编辑页可增删、替换和调整地点顺序，也可使用「删掉第二站」等自然语言指令。每次编辑携带 `baseVersion`，后端重新查询路网。超出约束的修改保留为待处理草稿，界面显示原因并提供恢复有效路线；处理草稿后才能保存分享。分享页可复制链接或行程清单，复制被浏览器拒绝时提供手动复制内容。
5. 地图瓦片加载失败时仍保留路线事实和地点清单，不由模型猜测路径。营业、预约及现场信息需要出发前核实。
6. 同一浏览器标签页通过 `sessionStorage` 暂存会话令牌和摘要，刷新、返回调整可继续对话。服务端验证令牌后恢复会话；网络失败保留输入，可重试。生成路线失败时保留已确认条件，调整后可以再次规划。服务端会话和未保存路线有默认 30 天的无活动清理期限。

本轮产品与体验设计见 [旅行 Agent 体验](docs/product-agent-experience.md)，测试范围及外部联调边界见 [验收记录](docs/agent-qa.md)。该版本继续聚焦单城短途旅行；预算金额、实时营业/排队、预约和多日行程尚未作为硬约束实现。

路线时间为基于开始时间、路网时长、建议停留和 10 分钟缓冲的**规划估计**；尚无实时营业、实时交通、预约或用户账户接入。公开底图默认使用 OSM 瓦片并显示 attribution；生产流量请配置符合服务条款的瓦片提供方。高德服务端坐标在地图展示前转换为 WGS-84，避免路线与底图错位。

## 架构与接口

当前体验路线策略见 [Experience Planning v2](docs/experience-planning-v2.md)。历史设计文档中的固定 8km 规则仅适用于已废弃的 `short-trip-v1` 策略。

- `apps/web`：React/Vite、响应式首页、对比、编辑与分享页面；只显示服务端返回的路线事实。
- `apps/api/src/deepseek.ts`：受限的意图提取、推荐文案和 JSON 校验。
- `apps/api/src/maps.ts`：高德地点、POI 和真实路网适配器，服务端密钥、超时和短缓存。
- `apps/api/src/planner.ts`：时间/交通发现范围、差异化束搜索、排期、约束校验与编辑重算。
- `apps/api/src/store.ts` / `pg-store.ts`：本地文件存储 / PostgreSQL 事务存储、乐观锁和不可变分享快照。
- `packages/contracts`：前后端共享 Zod Schema，`docs/openapi.yaml`：OpenAPI 3.1 契约。

主要端点：`POST /v1/sessions`、`GET /v1/sessions/{id}`、`POST /v1/sessions/{id}/turns`（读取/提交会话需 `x-session-token`）、`POST /v1/itineraries/generate`、`GET /v1/itineraries/{id}`、`POST /v1/itineraries/{id}/routes/{routeId}/edits`、`POST /v1/itineraries/{id}/routes/{routeId}/restore`、`POST /v1/itineraries/{id}/save`、`POST /v1/itineraries/{id}/share`、`GET /v1/shares/{token}`。完整请求与响应见 OpenAPI。

```powershell
pnpm typecheck
pnpm test
pnpm build
```

自动化测试用隔离的地图/模型替身验证业务规则，不会消耗真实 API 配额。真实外部联调需本地配置有效凭据，并核对高德密钥的 Web 服务权限、额度及所在网络可用性。
