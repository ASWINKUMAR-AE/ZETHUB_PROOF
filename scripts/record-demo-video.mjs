import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.resolve(ROOT, 'demo_video');

if (!fs.existsSync(VIDEO_DIR)) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

// Clean old recordings
for (const file of fs.readdirSync(VIDEO_DIR)) {
  if (file.endsWith('.webm') || file.endsWith('.mp4')) {
    try { fs.unlinkSync(path.join(VIDEO_DIR, file)); } catch {}
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function smoothScroll(page, targetY, steps = 15, delay = 50) {
  const currentY = await page.evaluate(() => window.scrollY);
  const diff = (targetY - currentY) / steps;
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), currentY + diff * i);
    await sleep(delay);
  }
}

async function main() {
  console.log('🚀 Starting ZetHub Proof Demo Video Recorder...');
  
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1920, height: 1080 },
    },
  });

  const page = await context.newPage();

  // Helper banner overlay to describe each feature in the video
  async function showCaption(title, subtitle) {
    console.log(`[Demo Scene] ${title} - ${subtitle}`);
    await page.evaluate(({ title, subtitle }) => {
      let banner = document.getElementById('zethub-demo-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'zethub-demo-banner';
        banner.style.position = 'fixed';
        banner.style.bottom = '28px';
        banner.style.left = '50%';
        banner.style.transform = 'translateX(-50%)';
        banner.style.zIndex = '999999';
        banner.style.background = 'rgba(15, 23, 42, 0.92)';
        banner.style.border = '1px solid rgba(99, 102, 241, 0.4)';
        banner.style.borderRadius = '14px';
        banner.style.padding = '12px 28px';
        banner.style.boxShadow = '0 20px 40px -10px rgba(0, 0, 0, 0.7), 0 0 25px rgba(99, 102, 241, 0.25)';
        banner.style.color = '#f8fafc';
        banner.style.fontFamily = 'Inter, system-ui, sans-serif';
        banner.style.display = 'flex';
        banner.style.alignItems = 'center';
        banner.style.gap = '16px';
        banner.style.backdropFilter = 'blur(12px)';
        banner.style.transition = 'all 0.3s ease';
        document.body.appendChild(banner);
      }
      banner.innerHTML = `
        <div style="background: linear-gradient(135deg, #6366f1, #3b82f6); width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4); flex-shrink: 0;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <div>
          <div style="font-size: 14px; font-weight: 700; color: #fff; letter-spacing: -0.01em;">${title}</div>
          <div style="font-size: 12px; color: #94a3b8; font-weight: 400; margin-top: 2px;">${subtitle}</div>
        </div>
      `;
    }, { title, subtitle });
  }

  // ==========================================
  // SCENE 1: AUTHENTICATION & LOGIN
  // ==========================================
  await page.goto('http://127.0.0.1:4000/auth');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'ZetHub Proof — Local-First Verification Platform',
    'Secure local authentication, encrypted session credentials & loopback-only API'
  );
  await sleep(2500);

  // Fill credentials with human-like typing
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  
  if (await emailInput.isVisible()) {
    await emailInput.click();
    await emailInput.fill('owner@zethub.local');
    await sleep(600);
    
    await passwordInput.click();
    await passwordInput.fill('ZetHub2026!Proof');
    await sleep(800);

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();
    await sleep(2000);
  }

  // ==========================================
  // SCENE 2: VERIFICATION DASHBOARD
  // ==========================================
  await page.waitForURL('http://127.0.0.1:4000/', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Verification Overview & Health Metrics',
    'Real-time pass rate metrics, system status, active runners & recent execution history'
  );
  await sleep(2000);

  await smoothScroll(page, 450);
  await sleep(2000);
  await smoothScroll(page, 0);
  await sleep(1500);

  // ==========================================
  // SCENE 3: PROJECTS & REAL STACK DETECTION
  // ==========================================
  await page.goto('http://127.0.0.1:4000/projects');
  await page.waitForLoadState('networkidle');
  await sleep(1000);

  await showCaption(
    'Projects Management & Workspace Explorer',
    'Non-destructive stack detection: probes package managers, lockfiles, APIs, DBs & Git state'
  );
  await sleep(2500);

  // Click on the self-verification project
  const projectCard = page.locator('text=ZetHub Proof Self-Verification').first();
  if (await projectCard.isVisible()) {
    await projectCard.click();
    await page.waitForLoadState('networkidle');
    await sleep(2000);

    await showCaption(
      'Deep Stack Detection Analysis',
      'Automated inspection of TypeScript, React 19, Fastify, MariaDB, Playwright & Vitest'
    );
    await sleep(3000);
    await smoothScroll(page, 350);
    await sleep(2000);
    await smoothScroll(page, 0);

    // ==========================================
    // SCENE 4: TEST CASES & DEPENDENCY-AWARE PLANNING
    // ==========================================
    const testCasesTab = page.locator('button[role="tab"]:has-text("Test cases")');
    if (await testCasesTab.isVisible()) {
      await testCasesTab.click();
      await sleep(1500);

      await showCaption(
        'Dependency-Aware Test Suite',
        '8 detected verification targets: TypeScript typecheck, ESLint, Unit, Integration, Security & E2E'
      );
      await sleep(3000);
      await smoothScroll(page, 400);
      await sleep(2500);
      await smoothScroll(page, 0);
    }

    // Environments Tab
    const envTab = page.locator('button[role="tab"]:has-text("Environments")');
    if (await envTab.isVisible()) {
      await envTab.click();
      await sleep(1200);
      await showCaption('Environment Management', 'Isolated runtime configurations for Local, Test, and CI runners');
      await sleep(2200);
    }

    // Quality Tab
    const qualityTab = page.locator('button[role="tab"]:has-text("Quality")');
    if (await qualityTab.isVisible()) {
      await qualityTab.click();
      await sleep(1200);
      await showCaption('Quality Auditor & Flaky-Test Detection', 'Flaky test indicators, coverage gap alerts and pass rate history');
      await sleep(2500);
    }

    // Repairs Tab
    const repairsTab = page.locator('button[role="tab"]:has-text("Repairs")');
    if (await repairsTab.isVisible()) {
      await repairsTab.click();
      await sleep(1200);
      await showCaption('Repair–Retest Workflow', 'Validates user or AI diffs using git apply --check; never blindly applies patches');
      await sleep(2500);
    }

    // Runs Tab inside Project
    const projRunsTab = page.locator('button[role="tab"]:has-text("Runs")');
    if (await projRunsTab.isVisible()) {
      await projRunsTab.click();
      await sleep(1500);
      await showCaption('Project Verification History', 'Immutable run records with timestamps, durations and pass/fail counts');
      await sleep(2000);
    }
  }

  // ==========================================
  // SCENE 5: VERIFICATION RUN DETAIL & EVIDENCE
  // ==========================================
  await page.goto('http://127.0.0.1:4000/runs');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Verification Runs History',
    'Full audit trail of all manual, CLI and scheduled verification runs'
  );
  await sleep(2500);

  // Click on the latest passed run
  const runRow = page.locator('a[href^="/runs/"]').first();
  if (await runRow.isVisible()) {
    await runRow.click();
    await page.waitForLoadState('networkidle');
    await sleep(2000);

    await showCaption(
      'Run Detail: 8/8 Passed Verification Execution',
      'Verified scope, honest limitation tracking, captured stdout/stderr and exit codes'
    );
    await sleep(3000);

    // Expand first few test results to showcase captured outputs
    const resultHeaders = page.locator('[data-state="closed"], button:has-text("js:"), button:has-text("unit")');
    const count = await resultHeaders.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      try {
        await resultHeaders.nth(i).click();
        await sleep(700);
      } catch {}
    }

    await smoothScroll(page, 500);
    await sleep(2500);
    await smoothScroll(page, 0);
    await sleep(1500);
  }

  // ==========================================
  // SCENE 6: EVIDENCE PASSPORTS & CRYPTOGRAPHY
  // ==========================================
  await page.goto('http://127.0.0.1:4000/evidence');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Evidence Passports — Signed Proof of Verification',
    'HTML Passport, machine-readable JSON, JUnit XML with SHA-256 hashes & HMAC manifest'
  );
  await sleep(3500);

  await smoothScroll(page, 300);
  await sleep(2000);
  await smoothScroll(page, 0);

  // ==========================================
  // SCENE 7: DATABASE & XAMPP INTEGRATION
  // ==========================================
  await page.goto('http://127.0.0.1:4000/database');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Database & XAMPP Administration',
    'MariaDB 10.4 health checks, 24 verified tables, migration deployer, backups & restore guards'
  );
  await sleep(3500);

  await smoothScroll(page, 350);
  await sleep(2000);
  await smoothScroll(page, 0);

  // ==========================================
  // SCENE 8: ANALYTICS & PASS RATE TRENDS
  // ==========================================
  await page.goto('http://127.0.0.1:4000/analytics');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Analytics & Quality Insights',
    'Pass rate trends, execution duration analysis and cross-run stability tracking'
  );
  await sleep(3000);

  // ==========================================
  // SCENE 9: INTEGRATIONS
  // ==========================================
  await page.goto('http://127.0.0.1:4000/integrations');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Integrations Hub',
    'Native connectors for Git, GitHub, Browser Extension, Database probes & AI assistants'
  );
  await sleep(3000);

  // ==========================================
  // SCENE 10: SETTINGS, TOKENS & ED25519 UPDATES
  // ==========================================
  await page.goto('http://127.0.0.1:4000/settings');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'Settings, Security & Device Tokens',
    'Device tokens for Chrome MV3 extension, user management and Ed25519-signed update feeds'
  );
  await sleep(3000);

  // ==========================================
  // SCENE 11: CLOSING — RETURN TO DASHBOARD
  // ==========================================
  await page.goto('http://127.0.0.1:4000/');
  await page.waitForLoadState('networkidle');
  await sleep(1500);

  await showCaption(
    'ZetHub Proof — Proof, Not Promises',
    'AI writes the code. ZetHub Proof proves it works. Local-first, private & verifiable.'
  );
  await sleep(4000);

  console.log('🎬 Wrapping up recording...');
  await page.close();
  await context.close();
  await browser.close();

  // Find recorded video file
  const files = fs.readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
  if (files.length === 0) {
    throw new Error('No video file was created by Playwright.');
  }

  const rawVideo = path.join(VIDEO_DIR, files[0]);
  const finalWebm = path.join(VIDEO_DIR, 'zethub-proof-demo.webm');
  const finalMp4 = path.join(VIDEO_DIR, 'zethub-proof-demo.mp4');

  fs.renameSync(rawVideo, finalWebm);
  console.log(`✅ WebM video saved: ${finalWebm}`);

  // Convert to high-quality MP4 using the bundled ffmpeg
  const ffmpegBin = path.resolve(ROOT, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(ffmpegBin)) {
    console.log('🔄 Converting WebM to MP4 with H.264 / AAC encoding...');
    try {
      execSync(`"${ffmpegBin}" -y -i "${finalWebm}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 22 -c:a aac "${finalMp4}"`, {
        stdio: 'inherit',
      });
      console.log(`✅ MP4 video saved: ${finalMp4}`);
    } catch (e) {
      console.warn('MP4 conversion encountered a notice:', e.message);
    }
  }

  console.log('🎉 Demo video recording complete!');
}

main().catch((err) => {
  console.error('Fatal error during recording:', err);
  process.exit(1);
});
