import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function checkSettingsSave(page, { settings, baseURL, maxConcurrency = 2 }) {
  await page.fill('loc=css:#baseURL', baseURL);
  await page.fill('loc=css:#maxConcurrency', String(maxConcurrency));
  await page.click('loc=css:#save');
  let saved;
  for (let i = 0; i < 30; i++) {
    saved = JSON.parse(await readFile(settings, 'utf8'));
    if (saved.baseURL === `${baseURL.replace(/\/$/, '')}/v1` && saved.maxConcurrency === maxConcurrency) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(saved.baseURL, `${baseURL.replace(/\/$/, '')}/v1`, 'Clicking Save inside the sandbox did not persist the Base URL');
  assert.equal(saved.maxConcurrency, maxConcurrency);
  await page.waitForSelector('text=已保存，设置已生效。', { timeout: 5000 });
  await page.fill('loc=css:#maxConcurrency', '0');
  await page.click('loc=css:#save');
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).maxConcurrency, maxConcurrency, 'An invalid limit was saved');
  await page.fill('loc=css:#maxConcurrency', String(maxConcurrency + 1));
  await page.press('loc=css:#maxConcurrency', 'Enter');
  for (let i = 0; i < 30; i++) {
    saved = JSON.parse(await readFile(settings, 'utf8'));
    if (saved.maxConcurrency === maxConcurrency + 1) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(saved.maxConcurrency, maxConcurrency + 1, 'Enter did not save the valid limit');
  console.log('PASS: sandbox Save persists Base URL and concurrency, invalid values stay unsaved, Enter saves');
}
