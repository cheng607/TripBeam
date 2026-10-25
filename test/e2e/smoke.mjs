import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const output = process.env.TRIPBEAM_E2E_OUTPUT || join(tmpdir(), 'tripbeam-e2e');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const passed = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(15_000);
const base = 'http://127.0.0.1:4174';
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const noOverflow = async (name) => {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `${name}: horizontal overflow ${JSON.stringify(dimensions)}`);
  passed.push(`${name}: no horizontal overflow`);
};
const turnResponse = () => page.waitForResponse((response) => response.url().includes('/turns') && response.request().method() === 'POST');
const editResponse = () => page.waitForResponse((response) => response.url().includes('/edits') && response.request().method() === 'POST');

try {
  await page.goto(base);
  await page.getByRole('heading', { name: /空出几小时/ }).waitFor();
  assert.ok((await page.locator('.draft-state').innerText()).includes('你的城市旅行助手'));
  await page.getByLabel('描述你的出行想法').fill('中文输入法选词');
  await page.getByLabel('描述你的出行想法').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tripbeam-agent-session-v1')), null);
  await page.getByLabel('描述你的出行想法').fill('');
  passed.push('Initial session status and IME Enter protection');
  await shot('01-home-desktop');
  await noOverflow('Home desktop');

  await page.getByRole('button', { name: '也可以直接选择出行条件 →' }).click();
  await page.getByRole('textbox', { name: '你从哪里出发？', exact: true }).fill('上海人民广场');
  await page.getByRole('button', { name: '确认出发点', exact: true }).click();
  await page.locator('input[aria-label="准备几点出发？"]').fill('14:00');
  await page.getByRole('button', { name: '确认时间', exact: true }).click();
  await page.getByRole('button', { name: '2 小时', exact: true }).click();
  await page.getByRole('button', { name: '拍照散步', exact: true }).click();
  await page.getByRole('button', { name: '确认游玩偏好', exact: true }).click();
  await page.getByRole('button', { name: '步行', exact: true }).click();
  await page.getByRole('button', { name: '确认出行方式', exact: true }).click();
  await page.waitForURL('**/compare/*');
  await page.locator('.route-card').first().waitFor();
  assert.ok(await page.locator('.route-card').count() >= 2);
  const compareUrl = page.url();
  const originalSession = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tripbeam-agent-session-v1')));
  assert.equal(originalSession.session.preference.startTime, '14:00');
  assert.equal(originalSession.session.preference.availableMinutes, 120);
  passed.push('Five-step preference form generates distinct route choices');

  await page.goto(base);
  await page.getByRole('link', { name: '继续查看方案 ↗' }).waitFor();
  await page.reload();
  await page.getByRole('link', { name: '继续查看方案 ↗' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.draft-state')?.textContent === '本次对话已保留');
  const restored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tripbeam-agent-session-v1')));
  assert.equal(restored.session.id, originalSession.session.id);
  assert.equal(restored.session.preference.originLabel, '上海人民广场');
  passed.push('Return home and reload preserve conversation and preference state');
  await page.getByRole('link', { name: '继续查看方案 ↗' }).click();
  await page.locator('.route-card').first().waitFor();
  const explain = turnResponse();
  await page.getByRole('button', { name: '为什么推荐这条', exact: true }).click();
  const explanation = await (await explain).json();
  assert.equal(explanation.intent, 'explain_route');
  assert.equal(explanation.session.itineraryIds.length, originalSession.session.itineraryIds.length);
  assert.equal(page.url(), compareUrl);
  await page.getByText('查看本次处理记录').waitFor();
  passed.push('Route explanation preserves itinerary instead of regenerating');
  await shot('02-compare-desktop');
  await noOverflow('Compare desktop');

  await page.getByRole('button', { name: '按这条路线继续 →' }).click();
  await page.waitForURL('**/editor/**');
  await page.locator('.stop-row').first().waitFor();
  const initialStops = await page.locator('.stop-row').count();
  if (initialStops > 1) {
    await page.getByLabel('用自然语言调整路线').fill('删掉第二站');
    const edited = turnResponse();
    await page.getByRole('button', { name: '调整路线 ↑', exact: true }).click();
    const result = await (await edited).json();
    assert.equal(result.intent, 'edit_route');
    await page.waitForFunction((count) => document.querySelectorAll('.stop-row').length === count, initialStops - 1);
    passed.push('Natural language removes the requested stop and recalculates');
  }

  let invalidDraft = false;
  for (let attempt = 0; attempt < 7 && !invalidDraft; attempt++) {
    await page.getByRole('button', { name: /^选择附近候选地点/ }).click();
    await page.getByRole('option').first().waitFor();
    await page.getByRole('option').first().click();
    const edited = editResponse();
    await page.getByRole('button', { name: '添加到行程末尾', exact: true }).click();
    const response = await edited;
    assert.equal(response.status(), 200);
    invalidDraft = Boolean((await response.json()).itinerary.invalidDraft);
    await page.getByRole('button', { name: '添加到行程末尾', exact: true }).waitFor();
  }
  assert.ok(invalidDraft, 'Fixture additions should eventually exceed the time budget');
  await page.getByRole('heading', { name: '这次修改还不能作为出行方案' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存路线', exact: true }).isDisabled(), true);
  await shot('03-invalid-draft-desktop');
  await page.getByRole('button', { name: '放弃草稿，恢复有效路线', exact: true }).click();
  await page.getByRole('heading', { name: '这次修改还不能作为出行方案' }).waitFor({ state: 'hidden' });
  passed.push('Time-overflow draft is visible, cannot be saved, and can be restored');
  await shot('04-editor-desktop');
  await noOverflow('Editor desktop');
  await page.getByRole('button', { name: '保存路线', exact: true }).click();
  await page.getByRole('button', { name: '✓ 已保存', exact: true }).waitFor();
  await page.getByRole('button', { name: '分享这份行程 ↗', exact: true }).click();
  await page.waitForURL('**/share/*');
  await page.locator('.share-timeline li').first().waitFor();
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard denied for acceptance test'); } }, configurable: true }); });
  await page.getByRole('button', { name: '复制行程清单 ↗', exact: true }).click();
  await page.getByLabel('可手动复制的分享内容').waitFor();
  assert.ok((await page.getByLabel('可手动复制的分享内容').inputValue()).includes('上海人民广场'));
  passed.push('Saved itinerary shares successfully; denied clipboard offers manual copy');
  await shot('05-share-desktop');
  await noOverflow('Share desktop');

  const shareUrl = page.url();
  const editorLink = await page.getByRole('link', { name: '返回继续调整', exact: true }).getAttribute('href');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, url, ready] of [
    ['home', base, '.planner-sidebar'],
    ['compare', compareUrl, '.route-card'],
    ['editor', `${base}${editorLink}`, '.stop-row'],
    ['share', shareUrl, '.share-timeline li'],
  ]) {
    await page.goto(url);
    await page.locator(ready).first().waitFor();
    await noOverflow(`${name} mobile 390px`);
    await shot(`06-${name}-mobile`);
  }
  assert.deepEqual(errors, [], 'No uncaught browser exceptions');
  passed.push('No uncaught browser exceptions');
  await writeFile(join(output, 'results.json'), JSON.stringify({ result: 'passed', fixture: 'offline-demo', checkedAt: new Date().toISOString(), passed, errors }, null, 2));
  console.log(JSON.stringify({ result: 'passed', checks: passed, output }, null, 2));
} catch (error) {
  await shot('failure').catch(() => {});
  const result = { result: 'failed', completed: passed, browserErrors: errors, url: page.url(), error: error instanceof Error ? error.stack : String(error), output };
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  throw error;
} finally {
  await browser.close();
}
