# 隔离浏览器回归

此环境专门用于验收界面交互与前后端闭环，全部地点和路网均为演示数据，不能作为真实出行建议。不加载开发者 `.env`、不调用地图或模型服务，也不写入本地真实行程库。API 使用临时目录与内存会话；正常停止后清理临时行程文件。

分别在两个终端启动：

```powershell
pnpm --filter @tripbeam/api exec tsx ../../test/e2e/server.ts
pnpm --filter @tripbeam/web exec vite --config ../../test/e2e/vite.config.mjs
```

访问 `http://127.0.0.1:4174/`，API 固定为 `http://127.0.0.1:3102`。后端源码改变后需重启 fixture；前端使用 Vite 自动更新。

`smoke.mjs` 使用 Playwright 与本机 Chrome。如果 Playwright 没安装在项目中，设置 `PLAYWRIGHT_PACKAGE` 为已有 Playwright 包目录；不需要修改应用依赖。可用 `PLAYWRIGHT_CHANNEL` 指定其他已安装 Chromium 浏览器，`TRIPBEAM_E2E_OUTPUT` 指定截图和报告目录。默认输出在系统临时目录 `tripbeam-e2e` 下。

```powershell
node test/e2e/smoke.mjs
```

脚本检查初始状态、中文输入法 Enter、五步条件补充、会话刷新恢复、解释路线不重新生成、自然语言删点、超时草稿恢复、保存分享、剪贴板失败兜底，以及桌面和 390px 手机视口的横向溢出。结果和截图都保留，失败时输出失败 URL 与截图路径。真实地图、模型输出质量、真实瓦片与生产数据库需另行验证。
