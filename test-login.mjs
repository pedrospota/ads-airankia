import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Go to login
console.log('1. Going to login page...');
await page.goto('https://ads.airankia.com/login');
await page.waitForLoadState('networkidle');
console.log('   Title:', await page.title());

// Take screenshot of login
await page.screenshot({ path: '/tmp/ads-login.png', fullPage: true });
console.log('   Screenshot saved: /tmp/ads-login.png');

// Login with credentials
console.log('2. Logging in...');
await page.fill('input[type="email"]', 'pedro@spota.mx');
await page.fill('input[type="password"]', 'loveislife2');
await page.click('button[type="submit"]');

// Wait for navigation
try {
  await page.waitForURL('**/brands**', { timeout: 10000 });
  console.log('   Redirected to:', page.url());
} catch (e) {
  console.log('   Current URL after login:', page.url());
  console.log('   Page content preview:', (await page.textContent('body')).slice(0, 500));
}

await page.waitForLoadState('networkidle');

// Take screenshot of brands page
await page.screenshot({ path: '/tmp/ads-brands.png', fullPage: true });
console.log('   Screenshot saved: /tmp/ads-brands.png');

// Check what's on the page
const brandCards = await page.$$('a[href*="/brands/"]');
console.log('3. Brand cards found:', brandCards.length);

if (brandCards.length === 0) {
  const bodyText = await page.textContent('body');
  console.log('   Body text:', bodyText.slice(0, 1000));
}

// Check for errors in console
page.on('console', msg => {
  if (msg.type() === 'error') console.log('   Console error:', msg.text());
});

await browser.close();
console.log('Done.');
