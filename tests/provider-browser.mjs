import assert from 'node:assert/strict';

export async function checkModelSelections(page) {
  const saveAndReopen = async () => {
    await page.click('loc=css:#modal .bar button:text-is("保存")');
    await page.waitForSelector('loc=css:#modal', { state: 'hidden' });
    await page.click('text=已登录 API key …only');
  };
  await page.click('loc=css:#modal button:text-is("全选")');
  await saveAndReopen();
  for (const id of ['gpt-6.1-sol', 'codex-auto-review', 'gpt-5.3-codex-spark']) {
    await page.click(`loc=css:#modal .mchip:has-text("${id}")`);
  }
  await saveAndReopen();
  const picked = await page.evaluate(() => [...document.querySelectorAll('#modal .mchip.on')].map(x => x.textContent.replace('✓', '').trim()));
  assert.deepEqual(picked, ['gpt-6-astra']);
  console.log('PASS: deselect three models, save and reopen with only Astra selected');
}
