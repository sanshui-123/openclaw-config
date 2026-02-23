'use strict';
const { fetchWithBrowserContext } = require('"./fetch_helper"');

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { execFileSync, spawn } = require('child_process');

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config/lovart.selectors.json');
const DEFAULT_BASE_URL = 'https://www.lovart.ai';

let cachedPersistentContext = null;
let cachedPersistentBrowser = null;
let cachedPersistentMeta = null;
let claimedCanvasPages = new Set();
let intercomSuppressedPages = new WeakSet();

function claimCanvasPage(page) {
  if (!page || claimedCanvasPages.has(page)) return false;
  claimedCanvasPages.add(page);
  try {
    page.once('close', () => claimedCanvasPages.delete(page));
  } catch (_err) {
    // ignore
  }
  return true;
}

function unclaimCanvasPage(page) {
  if (!page) return;
  claimedCanvasPages.delete(page);
}

function isCanvasPageClaimed(page) {
  return !!(page && claimedCanvasPages.has(page));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

class Logger {
  constructor(logPath) {
    this.logPath = logPath;
    if (logPath) {
      ensureDir(path.dirname(logPath));
    }
  }

  info(message) {
    this.write('INFO', message);
  }

  warn(message) {
    this.write('WARN', message);
  }

  error(message) {
    this.write('ERROR', message);
  }

  write(level, message) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    if (this.logPath) {
      fs.appendFileSync(this.logPath, `${line}\n`);
    }
  }
}

function loadSelectors(configPath) {
  const resolvedPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(resolvedPath)) {
    return {
      base_url: DEFAULT_BASE_URL,
      create_url: DEFAULT_BASE_URL,
      timeouts: {},
      selectors: {
        promptInput: ['textarea', 'div[contenteditable="true"]'],
        referenceButton: ['text=参考图', 'text=参考图片', 'text=参考'],
        referenceFileInput: ['input[type="file"]'],
        generateButton: ['text=生成'],
        doneIndicators: ['text=下载', 'text=导出'],
        downloadButtons: ['text=下载'],
        loginIndicators: ['text=登录', 'text=验证码'],
        guardIndicators: ['text=验证码']
      }
    };
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    configPath: resolvedPath,
    base_url: parsed.base_url || parsed.baseUrl || DEFAULT_BASE_URL,
    create_url: parsed.create_url || parsed.createUrl || parsed.base_url || parsed.baseUrl || DEFAULT_BASE_URL,
    timeouts: parsed.timeouts || {},
    prefer_direct_download: parsed.prefer_direct_download === true,
    download_dir: parsed.download_dir || parsed.downloadDir || '',
    direct_download_concurrency: parsed.direct_download_concurrency || parsed.directDownloadConcurrency || 0,
    selectors: parsed.selectors || {},
    bitbrowser: parsed.bitbrowser || parsed.bitBrowser || {},
    browser: parsed.browser || {}
  };
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/$/, '');
}

function extractProjectIdFromUrl(url) {
  const match = String(url || '').match(/[?&]projectId=([^&]+)/);
  return match ? match[1] : '';
}

function isPageClosedError(err) {
  if (err && err.code === 'PAGE_CLOSED') return true;
  const message = String(err && err.message ? err.message : err || '');
  return /Target page, context or browser has been closed|Page closed|Browser has been closed|Session closed/i.test(message);
}

function isFrameDetachedError(err) {
  const message = String(err && err.message ? err.message : err || '');
  return /Frame has been detached|Execution context was destroyed|Cannot find context with specified id/i.test(message);
}

function isElementDetachedError(err) {
  const message = String(err && err.message ? err.message : err || '');
  return /HANDLE_DETACHED|Element is not attached to the DOM|Node is detached|JSHandle is disposed|Cannot find context with specified id|Execution context was destroyed/i.test(message);
}

function assertPageOpen(page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    const error = new Error('PAGE_CLOSED');
    error.code = 'PAGE_CLOSED';
    throw error;
  }
}


function isAbortSignalAborted(signal) {
  return Boolean(signal && signal.aborted);
}

function getAbortReason(signal) {
  if (!signal) return '';
  if (typeof signal.reason === 'string') return signal.reason;
  if (signal.reason && typeof signal.reason === 'object' && signal.reason.message) return String(signal.reason.message);
  return '';
}

function throwIfAborted(signal, logger) {
  if (!isAbortSignalAborted(signal)) return;
  const reason = getAbortReason(signal) || 'aborted';
  if (logger) logger.warn(`任务中止: ${reason}`);
  const error = new Error(`lovart_aborted:${reason}`);
  error.code = 'ABORTED';
  throw error;
}

function parseCdpPort(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) return port;
  } catch (_err) {
    // ignore
  }
  const match = String(cdpUrl || '').match(/:(\d+)/);
  if (match) {
    const port = Number(match[1]);
    if (Number.isFinite(port) && port > 0) return port;
  }
  return 9888;
}

function resolveChromeExecutable(executablePath) {
  if (executablePath) return executablePath;
  const defaultPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(defaultPath)) return defaultPath;
  return '';
}

async function isCdpAvailable(cdpUrl) {
  const base = String(cdpUrl || '').replace(/\/$/, '');
  const url = base.endsWith('/json/version') ? base : `${base}/json/version`;
  try {
    const resp = await axios.get(url, { timeout: 2000 });
    return resp && resp.status >= 200 && resp.status < 300;
  } catch (_err) {
    return false;
  }
}

async function startCdpChrome({ cdpUrl, userDataDir, executablePath, logger }) {
  const port = parseCdpPort(cdpUrl);
  const chromePath = resolveChromeExecutable(executablePath);
  if (!chromePath) {
    throw new Error('未找到 Chrome 可执行文件，请配置 browser.cdp_executable_path');
  }
  const args = [
    `--remote-debugging-port=${port}` ,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}` ,
    '--no-first-run',
    '--no-default-browser-check'
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  if (logger) logger.info('已自动启动 Chrome（CDP）');
}

async function ensureCdpReady({ cdpUrl, userDataDir, executablePath, logger }) {
  if (await isCdpAvailable(cdpUrl)) return true;
  await startCdpChrome({ cdpUrl, userDataDir, executablePath, logger });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isCdpAvailable(cdpUrl)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('CDP 启动失败，请检查 Chrome 是否可用');
}

function isCanvasPage(page) {
  if (!page) return false;
  try {
    return /lovart\.ai\/canvas/i.test(page.url());
  } catch (_err) {
    return false;
  }
}

function isRelatedCanvasPage(page, sourcePage) {
  if (!page) return false;
  if (!sourcePage) return true;
  if (page === sourcePage) return true;
  try {
    if (!page.opener) return true;
    const opener = page.opener();
    if (!opener) return true;
    return opener === sourcePage;
  } catch (_err) {
    return true;
  }
}

async function launchPersistentContext({
  userDataDir,
  headless,
  channel,
  executablePath,
  args,
  logger
}) {
  const baseOptions = {
    headless: headless === true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    args: Array.isArray(args) ? args : []
  };
  if (channel) baseOptions.channel = channel;
  if (executablePath) baseOptions.executablePath = executablePath;
  try {
    return await chromium.launchPersistentContext(userDataDir, baseOptions);
  } catch (err) {
    if (channel && !executablePath) {
      if (logger) {
        logger.warn(`Chrome 启动失败，回退到内置 Chromium: ${err.message}`);
      }
      const fallbackOptions = { ...baseOptions };
      delete fallbackOptions.channel;
      return await chromium.launchPersistentContext(userDataDir, fallbackOptions);
    }
    throw err;
  }
}

function getAllContextPages(context) {
  if (!context) return [];
  try {
    const browser = context.browser && context.browser();
    if (browser && typeof browser.contexts === 'function') {
      const pages = [];
      for (const ctx of browser.contexts()) {
        pages.push(...ctx.pages());
      }
      return pages;
    }
  } catch (_err) {
    // ignore
  }
  return context.pages();
}

function pickExistingPage(context, options = {}) {
  if (!context) return null;
  const lovartOnly = options.lovartOnly === true;
  let pages = getAllContextPages(context);
  if (lovartOnly) {
    pages = pages.filter(page => {
      try {
        return /lovart\.ai/i.test(page.url());
      } catch (_err) {
        return false;
      }
    });
  }
  if (!pages.length) return null;
  const canvasPage = pages.find(page => isCanvasPage(page) && !isCanvasPageClaimed(page));
  if (canvasPage) return canvasPage;
  const homePage = pages.find(page => /lovart\.ai\/(zh\/home|home)/i.test(page.url()));
  if (homePage) return homePage;
  const nonCanvas = pages.find(page => /lovart\.ai/i.test(page.url()) && !/lovart\.ai\/canvas/i.test(page.url()));
  return nonCanvas || pages.find(page => /lovart\.ai/i.test(page.url())) || pages[0];
}

async function waitForCanvasPage(context, currentPage, timeoutMs, logger, ignoreProjectIds) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  const isAllowed = page => {
    if (!page) return false;
    if (!isCanvasPage(page)) return false;
    if (isCanvasPageClaimed(page)) return false;
    if (!isRelatedCanvasPage(page, currentPage)) return false;
    if (ignoreProjectIds && ignoreProjectIds.size) {
      try {
        const projectId = extractProjectIdFromUrl(page.url());
        if (projectId && ignoreProjectIds.has(projectId)) return false;
      } catch (_err) {
        // ignore
      }
    }
    return true;
  };
  if (currentPage && isAllowed(currentPage) && claimCanvasPage(currentPage)) return currentPage;
  if (!context) return null;
  while (Date.now() < deadline) {
    const pages = getAllContextPages(context);
    const canvas = pages.find(page => isAllowed(page));
    if (canvas && claimCanvasPage(canvas)) return canvas;

    const candidate = await Promise.race([
      context.waitForEvent('page', { timeout: 1000 }).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 1000))
    ]);
    if (candidate) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 10000 });
      } catch (_err) {
        // ignore
      }
      if (isAllowed(candidate) && claimCanvasPage(candidate)) {
        return candidate;
      }
    }
  }
  if (logger) logger.warn('未检测到 canvas 页面');
  return null;
}

async function focusCanvas(page, selectors, logger) {
  await dismissBlockingOverlays(page, logger);
  const canvasSelectors = selectors.canvasContainer || [];
  const clicked = await clickFirstMatch(page, canvasSelectors, logger);
  if (!clicked) {
    try {
      await page.mouse.click(300, 300);
    } catch (_err) {
      // ignore
    }
  }
  await page.waitForTimeout(200);
}

async function hasSelectionToolbar(page) {
  try {
    return await page.evaluate(() => {
      return !!document.querySelector('div.border-panel,div[class*="border-panel"]');
    });
  } catch (_err) {
    return false;
  }
}

async function clickCanvasPoints(page, selectors, logger) {
  try {
    const box = await page.evaluate((selList) => {
      const selectors = (selList || []).length ? selList : ['div.konvajs-content', 'canvas'];
      let el = null;
      for (const sel of selectors) {
        const candidate = document.querySelector(sel);
        if (candidate) {
          el = candidate;
          break;
        }
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }, selectors && selectors.canvasContainer ? selectors.canvasContainer : []);
    if (!box) return false;
    const points = [
      { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
      { x: Math.max(10, box.left + 10), y: Math.max(10, box.top + 10) },
      { x: Math.max(10, box.right - 10), y: Math.max(10, box.bottom - 10) }
    ];
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(120);
    }
    if (logger) logger.info('已点击画布多个点以激活焦点');
    return true;
  } catch (err) {
    if (logger) logger.warn(`点击画布焦点失败: ${err.message}`);
    return false;
  }
}

async function pressSelectAll(page) {
  const isMac = process.platform === 'darwin';
  const primary = isMac ? 'Meta+A' : 'Control+A';
  const secondary = isMac ? 'Control+A' : 'Meta+A';
  try {
    await page.keyboard.press(primary);
  } catch (_err) {
    // ignore
  }
  await page.waitForTimeout(100);
  try {
    await page.keyboard.press(secondary);
  } catch (_err) {
    // ignore
  }
}

async function pressSelectTool(page, logger) {
  try {
    await page.keyboard.press('V');
    if (logger) logger.info('已发送选择工具快捷键 V');
  } catch (_err) {
    // ignore
  }
}

async function clickElementCenter(page, handle) {
  try {
    const box = await handle.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  } catch (_err) {
    return false;
  }
}

async function forceClickNative(page, handle) {
  try {
    await page.evaluate(el => {
      el.click();
    }, handle);
    return true;
  } catch (_err) {
    return false;
  }
}

async function tryShiftSelectThumbnails(page, logger) {
  const selectors = [
    'img',
    '[data-testid*="thumb"]',
    '[data-testid*="thumbnail"]',
    '.thumbnail',
    '.thumb',
    '.result-item',
    '.result-card',
    '.image-card',
    '.gallery-item'
  ];
  try {
    const handles = [];
    for (const sel of selectors) {
      const list = await page.$$(sel);
      list.forEach(item => handles.push(item));
    }
    if (handles.length < 2) return false;
    const first = handles[0];
    const last = handles[handles.length - 1];
    const clickedFirst = await clickElementCenter(page, first);
    if (!clickedFirst) return false;
    await page.keyboard.down('Shift');
    const clickedLast = await clickElementCenter(page, last);
    await page.keyboard.up('Shift');
    if (clickedLast && logger) logger.info('已尝试 Shift 连选缩略图');
    return clickedLast;
  } catch (err) {
    if (logger) logger.warn(`Shift 连选尝试失败: ${err.message}`);
    return false;
  }
}

async function setCanvasPointerEvents(page, mode, logger) {
  try {
    const count = await page.evaluate((mode) => {
      const selectors = [
        '#elements-canvas',
        '[data-testid="elements-canvas"]',
        'canvas',
        '.canvas-container'
      ];
      const elements = new Set();
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => elements.add(el));
      });
      let changed = 0;
      elements.forEach(el => {
        if (mode === 'disable') {
          if (el.dataset.lovartPrevPointerEvents === undefined) {
            el.dataset.lovartPrevPointerEvents = el.style.pointerEvents || '';
          }
          if (el.style.pointerEvents !== 'none') {
            el.style.pointerEvents = 'none';
            changed += 1;
          }
        } else {
          if (el.dataset.lovartPrevPointerEvents !== undefined) {
            el.style.pointerEvents = el.dataset.lovartPrevPointerEvents;
            delete el.dataset.lovartPrevPointerEvents;
            changed += 1;
          } else if (el.style.pointerEvents === 'none') {
            el.style.pointerEvents = '';
            changed += 1;
          }
        }
      });
      return changed;
    }, mode);
    if (logger && count) {
      logger.info(mode === 'disable'
        ? `已临时禁用画布指针事件: ${count}`
        : `已恢复画布指针事件: ${count}`);
    }
    return count;
  } catch (err) {
    if (logger) logger.warn(`调整画布指针事件失败: ${err.message}`);
    return 0;
  }
}

async function disableCanvasPointerEvents(page, logger) {
  return setCanvasPointerEvents(page, 'disable', logger);
}

async function restoreCanvasPointerEvents(page, logger) {
  return setCanvasPointerEvents(page, 'restore', logger);
}

async function applyDownloadBehavior(context, page, downloadDir, logger) {
  if (!context || !page || !downloadDir) return false;
  if (page.__lovartDownloadDir === downloadDir) return true;
  try {
    ensureDir(downloadDir);
    if (typeof context.newCDPSession !== 'function') return false;
    const session = await context.newCDPSession(page);
    try {
      await session.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir
      });
      page.__lovartDownloadDir = downloadDir;
      if (logger) logger.info(`已设置下载目录: ${downloadDir}`);
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (err) {
    if (logger) logger.warn(`设置下载目录失败: ${err.message}`);
    return false;
  }
}

async function pickRightmostHandle(handles) {
  if (!Array.isArray(handles) || !handles.length) return null;
  const entries = await Promise.all(handles.map(async handle => {
    try {
      const box = await handle.boundingBox();
      if (!box) return null;
      return { handle, right: box.x + box.width, top: box.y };
    } catch (_err) {
      return null;
    }
  }));
  const valid = entries.filter(Boolean);
  if (!valid.length) return null;
  valid.sort((a, b) => {
    if (b.right !== a.right) return b.right - a.right;
    return a.top - b.top;
  });
  return valid[0].handle || null;
}

async function clickZoomOut(page, selectors, logger) {
  const zoomSelectors = selectors.zoomOutButton || [];
  if (zoomSelectors.length) {
    const clicked = await clickFirstMatch(page, zoomSelectors, logger);
    if (clicked) {
      if (logger) logger.info('已点击缩小按钮');
      return true;
    }
  }

  try {
    const clicked = await page.evaluate(() => {
      const percentEl = Array.from(document.querySelectorAll('*'))
        .find(el => el.childElementCount === 0 && /\d+%/.test(el.textContent || ''));
      if (!percentEl) return false;
      const container = percentEl.closest('div') || percentEl.parentElement;
      if (!container) return false;
      const buttons = Array.from(container.querySelectorAll('button'));
      const minusBtn = buttons.find(btn => {
        const text = (btn.textContent || '').trim();
        return text === '-' || text === '−';
      });
      if (minusBtn) {
        minusBtn.click();
        return true;
      }
      const labeled = buttons.find(btn => {
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.title || ''}`.trim();
        return /缩小|减小|zoom out/i.test(label);
      });
      if (labeled) {
        labeled.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      if (logger) logger.info('已通过缩放控件缩小画布');
      return true;
    }
  } catch (_err) {
    // ignore
  }

  return false;
}

async function waitForDownloadAllAfterSelection(page, selectors, timeoutMs, logger, abortSignal) {
  if (!selectors.downloadAllButton || selectors.downloadAllButton.length === 0) {
    throw new Error('require_download_all 启用但未配置 downloadAllButton');
  }
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  let zoomAttempts = 0;
  const maxZoomAttempts = 8;

  while (Date.now() < deadline) {
    assertPageOpen(page);
    throwIfAborted(abortSignal, logger);
    const ready = await waitForAnySelector(page, selectors.downloadAllButton, 1000);
    if (ready) return ready;
    const fallback = await findDownloadAllFallback(page, logger, { allowFallback: false });
    if (fallback) return 'fallback:download-all';
    if (zoomAttempts < maxZoomAttempts) {
      const zoomed = await clickZoomOut(page, selectors, logger);
      if (zoomed) {
        zoomAttempts += 1;
        await page.waitForTimeout(500);
        await pressSelectAll(page);
        await page.waitForTimeout(300);
        continue;
      }
      zoomAttempts = maxZoomAttempts;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function findDownloadAllFallback(page, logger, { allowFallback } = {}) {
  let buttons = [];
  try {
    buttons = await page.$$('button');
  } catch (_err) {
    buttons = [];
  }
  if (!buttons.length) return null;
  const viewport = page.viewportSize ? page.viewportSize() : null;
  const candidates = [];
  for (const handle of buttons) {
    let info = null;
    try {
      info = await handle.evaluate(el => ({
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: (el.innerText || '').trim(),
        className: el.className || '',
        hasSvg: !!el.querySelector('svg')
      }));
    } catch (_err) {
      continue;
    }
    const label = `${info.aria} ${info.title} ${info.text}`.toLowerCase();
    if (/(下载|导出|download|export)/i.test(label)) {
      return { handle, reason: `label:${label.trim()}` };
    }
    if (!allowFallback) continue;
    if (!info.hasSvg) continue;
    if (!/flex-shrink-0/.test(info.className) || !/rounded-lg/.test(info.className)) continue;
    if (!/gap-1/.test(info.className)) continue;
    const box = await handle.boundingBox().catch(() => null);
    if (!box) continue;
    if (viewport && box.y > 120) continue;
    if (viewport && box.x < (viewport.width - 300)) continue;
    candidates.push({ handle, label, className: info.className, box });
  }

  if (allowFallback && candidates.length === 1) {
    if (logger) logger.info('下载按钮使用类名回退匹配');
    return { handle: candidates[0].handle, reason: 'class-fallback' };
  }
  if (allowFallback && candidates.length > 1 && logger) {
    const summary = candidates.slice(0, 6).map(item => {
      return `${Math.round(item.box.x)},${Math.round(item.box.y)}:${item.className}`;
    }).join(' | ');
    logger.warn(`下载按钮候选过多，需人工确认: ${summary}`);
  }
  return null;
}

async function closeHomePage(originPage, activePage, logger) {
  if (!originPage || originPage === activePage) return;
  let url = '';
  try {
    url = originPage.url();
  } catch (_err) {
    return;
  }
  if (!/lovart\.ai\/zh\/home|lovart\.ai\/home/i.test(url)) return;
  try {
    await originPage.close();
    if (logger) logger.info('已关闭 home 页面');
  } catch (_err) {
    // ignore
  }
}

async function isLovartPage(page) {
  try {
    const url = page.url();
    // 只关闭 canvas 页面（包含 projectId 参数），保留主页
    return /canvas\?agent=1/i.test(url) && /projectId=/i.test(url);
  } catch (_err) {
    return false;
  }
}

async function refreshPageIfBlank(page, logger) {
  try {
    const url = page.url();
    const isLovartUrl = /lovart\.ai/i.test(url);
    
    if (!isLovartUrl) return false;
    
    // 检查页面是否空白（通过关键元素）
    const isBlank = await page.evaluate(() => {
      // 检查关键元素是否存在
      const canvas = document.querySelector('canvas');
      const sidebar = document.querySelector('.left-toolbar-position') || document.querySelector('[class*="left-toolbar"]');
      const toolbar = document.querySelector('button[class*="rounded-full"]') || document.querySelector('[class*="bg-[#2F3640]"]');
      
      // 如果完全没有这些关键元素，认为是空白页
      return !canvas && !sidebar && !toolbar;
    });
    
    if (isBlank) {
      if (logger) logger.info('检测到空白页，执行刷新...');
      await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
      if (logger) logger.info('页面刷新完成');
      return true;
    }
    
    return false;
  } catch (_err) {
    return false;
  }
}

async function reopenCanvasPage(context, canvasUrl, fallbackUrl, navigationTimeout, logger) {
  if (!context) {
    throw new Error('页面恢复失败：缺少浏览器上下文');
  }
  const target = canvasUrl || fallbackUrl || '';
  const newPage = await context.newPage();
  try {
    if (target) {
      await newPage.goto(target, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    }
  } catch (err) {
    if (logger) logger.warn(`恢复页面跳转失败: ${err.message}`);
  }
  if (logger) {
    logger.warn(`已尝试恢复页面: ${target || 'about:blank'}`);
  }
  return newPage;
}

function buildPersistentMeta({ userDataDir, channel, executablePath }) {
  return {
    userDataDir: String(userDataDir || ''),
    channel: String(channel || ''),
    executablePath: String(executablePath || '')
  };
}

function isSamePersistentMeta(a, b) {
  if (!a || !b) return false;
  return a.userDataDir === b.userDataDir &&
    a.channel === b.channel &&
    a.executablePath === b.executablePath;
}

async function getPersistentContext({
  userDataDir,
  headless,
  channel,
  executablePath,
  args,
  logger,
  reuse
}) {
  const meta = buildPersistentMeta({ userDataDir, channel, executablePath });
  if (reuse && cachedPersistentContext && cachedPersistentBrowser && cachedPersistentBrowser.isConnected()) {
    if (isSamePersistentMeta(cachedPersistentMeta, meta)) {
      return cachedPersistentContext;
    }
  }
  if (cachedPersistentContext) {
    try {
      await cachedPersistentContext.close();
    } catch (_err) {
      // ignore
    }
  }
  cachedPersistentContext = await launchPersistentContext({
    userDataDir,
    headless,
    channel,
    executablePath,
    args,
    logger
  });
  cachedPersistentBrowser = cachedPersistentContext.browser();
  cachedPersistentMeta = meta;
  return cachedPersistentContext;
}

function buildBitApiHeaders(token, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (token && !headers['x-api-key'] && !headers['X-API-KEY']) {
    headers['x-api-key'] = token;
  }
  return headers;
}

async function openBitBrowserProfile({ apiBase, apiToken, apiHeaders, profileId }) {
  const resp = await axios.post(
    `${apiBase}/browser/open`,
    {
      id: profileId,
      args: [],
      loadExtensions: true
    },
    { timeout: 30000, headers: buildBitApiHeaders(apiToken, apiHeaders) }
  );
  const ws = resp?.data?.data?.ws || resp?.data?.data?.wsEndpoint;
  if (!ws) {
    throw new Error('BitBrowser /browser/open did not return ws');
  }
  return ws;
}

async function waitForAnySelector(page, selectors, timeoutMs) {
  if (!Array.isArray(selectors) || selectors.length === 0) return null;
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const tasks = selectors.map(selector =>
    page.waitForSelector(selector, { timeout: safeTimeout }).then(() => selector)
  );
  try {
    return await Promise.any(tasks);
  } catch (_err) {
    return null;
  }
}

async function waitForAnyHandle(page, selectors, timeoutMs, options = {}) {
  const selector = await waitForAnySelector(page, selectors, timeoutMs);
  if (!selector) return null;
  const allowHidden = options.allowHidden === true;
  if (allowHidden) {
    try {
      const handle = await page.$(selector);
      return handle ? { selector, handle } : null;
    } catch (_err) {
      return null;
    }
  }
  return await findFirstHandle(page, [selector], options);
}

async function hasAnySelector(page, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) return false;
  for (const selector of selectors) {
    try {
      const handle = await page.$(selector);
      if (handle) return true;
    } catch (_err) {
      // ignore
    }
  }
  return false;
}

async function suppressIntercomOverlay(page, logger) {
  if (!page || intercomSuppressedPages.has(page)) return false;
  try {
    const found = await page.evaluate(() => {
      const nodes = [];
      const container = document.querySelector('#intercom-container');
      if (container) nodes.push(container);
      const frame = document.querySelector('iframe[data-intercom-frame]');
      if (frame) nodes.push(frame);
      nodes.forEach(node => {
        node.style.pointerEvents = 'none';
      });
      return nodes.length > 0;
    });
    if (found) {
      await page.addStyleTag({
        content: '#intercom-container, iframe[data-intercom-frame]{pointer-events:none !important;}'
      });
      intercomSuppressedPages.add(page);
      if (logger) logger.info('已禁用 Intercom 遮挡');
      return true;
    }
  } catch (err) {
    if (logger) logger.warn(`禁用 Intercom 遮挡失败: ${err.message}`);
  }
  return false;
}

async function hasPromptHistory(page, selectors, logger) {
  const historySelectors = selectors.promptHistory || [];
  if (!historySelectors.length) return false;
  try {
    return await page.evaluate(list => {
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text.length >= 20) return true;
      }
      return false;
    }, historySelectors);
  } catch (err) {
    if (logger) logger.warn(`检测提示词历史失败: ${err.message}`);
    return false;
  }
}

function normalizePromptText(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function buildPromptSignature(promptText) {
  const raw = String(promptText || '').trim();
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const filtered = lines.filter(line => !/^\[@image/i.test(line) && !/^https?:\/\//i.test(line));
  const base = filtered[0] || lines[0] || '';
  return normalizePromptText(base).slice(0, 32);
}

async function getPromptHistoryText(page, selectors) {
  const historySelectors = selectors.promptHistory || [];
  if (!historySelectors.length) return '';
  try {
    return await page.evaluate(list => {
      const chunks = [];
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text) chunks.push(text);
      }
      return chunks.join('\n');
    }, historySelectors);
  } catch (_err) {
    return '';
  }
}

function historyMatchesPrompt(historyText, promptSignature) {
  const normalized = normalizePromptText(historyText || '');
  if (!promptSignature) return normalized.length >= 20;
  return normalized.includes(promptSignature);
}

async function canvasHasPromptOrImages(page, selectors, promptSignature, logger) {
  if (!page) return false;
  const historyText = await getPromptHistoryText(page, selectors);
  if (historyMatchesPrompt(historyText, promptSignature)) return true;
  try {
    const urls = await collectAgentImageUrls(page);
    if (urls && urls.length) return true;
  } catch (_err) {
    // ignore
  }
  try {
    const stats = await collectResultImageStats(page);
    if (stats && stats.visualCount) return true;
  } catch (_err) {
    // ignore
  }
  if (logger && historyText) {
    logger.info('提示词历史未匹配当前任务，可能是旧画布');
  }
  return false;
}

async function findCanvasPageWithPrompt(context, currentPage, selectors, promptSignature, logger, ignoreProjectIds) {
  if (!context) return null;
  const pages = getAllContextPages(context);
  for (const candidate of pages) {
    if (!isCanvasPage(candidate)) continue;
    if (isCanvasPageClaimed(candidate)) continue;
    if (!isRelatedCanvasPage(candidate, currentPage)) continue;
    if (ignoreProjectIds && ignoreProjectIds.size) {
      try {
        const projectId = extractProjectIdFromUrl(candidate.url());
        if (projectId && ignoreProjectIds.has(projectId)) continue;
      } catch (_err) {
        // ignore
      }
    }
    const ok = await canvasHasPromptOrImages(candidate, selectors, promptSignature, logger);
    if (ok && claimCanvasPage(candidate)) return candidate;
  }
  return null;
}

async function waitForNoBusyIndicators(page, selectors, timeoutMs, logger) {
  const indicators = selectors.busyIndicators || [];
  if (!indicators.length) return true;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    assertPageOpen(page);
    const busy = await hasAnySelector(page, indicators);
    if (!busy) return true;
    const now = Date.now();
    if (logger && now - lastLogAt > 15000) {
      logger.info('检测到生成中/思考中标记，继续等待...');
      lastLogAt = now;
    }
    await page.waitForTimeout(1000);
  }
  if (logger) {
    logger.warn('生成中标记持续存在，停止下载');
  }
  return false;
}

async function waitForGenerationSignal(page, selectors, timeoutMs, logger) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Date.now() + 20000;
  const signalSelectors = [
    ...(selectors.busyIndicators || []),
    ...(selectors.downloadAllButton || []),
    ...(selectors.downloadButtons || []),
    ...(selectors.doneIndicators || [])
  ];
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    assertPageOpen(page);
    try {
      if (isCanvasPage(page)) return true;
    } catch (_err) {
      // ignore
    }
    const hit = await hasAnySelector(page, signalSelectors);
    if (hit) return true;
    const now = Date.now();
    if (logger && now - lastLogAt > 10000) {
      logger.info('尚未检测到生成信号，继续等待...');
      lastLogAt = now;
    }
    await page.waitForTimeout(500);
  }
  if (logger) logger.warn('生成启动信号未出现');
  return false;
}

async function waitForGenerationReady(page, selectors, expectedCount, minCount, timeoutMs, logger, abortSignal) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Date.now() + 180000;
  const busySelectors = selectors.busyIndicators || [];
  const hasBusySelectors = busySelectors.length > 0;
  const minTarget = Number.isFinite(minCount) && minCount > 0
    ? Math.max(1, Math.floor(minCount))
    : (Number.isFinite(expectedCount) && expectedCount > 0
      ? Math.max(1, Math.floor(expectedCount))
      : 1);
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    assertPageOpen(page);
    throwIfAborted(abortSignal, logger);
    if (await hasGenerationErrorIndicator(page, selectors)) {
      if (logger) logger.warn('检测到生成错误提示，终止等待');
      throw new Error('generation_error');
    }
    const busy = hasBusySelectors ? await hasAnySelector(page, busySelectors) : false;
    const urls = await collectAgentImageUrls(page);
    let visualCount = 0;
    let summaryCount = 0;
    let count = urls.length;
    if ((expectedCount && count < expectedCount) || count < minTarget) {
      const stats = await collectResultImageStats(page);
      visualCount = stats.visualCount || 0;
      summaryCount = stats.summaryCount || 0;
      count = resolveEffectiveImageCount(count, visualCount, summaryCount);
    }
    if (expectedCount && count >= expectedCount) {
      return { selector: `images:${count}`, urls };
    }
    if (count >= minTarget) {
      return { selector: `images:${count}`, urls };
    }
    const now = Date.now();
    if (logger && now - lastLogAt > 15000) {
      const detail = `url:${urls.length}, visual:${visualCount}`;
      logger.info(
        busy
          ? `检测到生成中/思考中标记，继续等待... (${detail})`
          : `未检测到足够图片，继续等待... (${detail})`
      );
      lastLogAt = now;
    }
    await page.waitForTimeout(1000);
  }
  if (logger) logger.warn('生成完成信号未出现');
  return null;
}
async function waitForGenerationStart(page, _selectors, timeoutMs, logger) {
  const delayMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
  await page.waitForTimeout(delayMs);
  if (logger) logger.info(`生成启动延迟等待完成: ${delayMs}ms`);
  return true;
}

async function hasCancelIndicator(page, selectors) {
  if (!page) return false;
  const cancelSelectors = selectors.cancelIndicators || [];
  if (cancelSelectors.length && await hasAnySelector(page, cancelSelectors)) return true;
  try {
    return await page.evaluate(() => {
      const text = (document.body && (document.body.innerText || document.body.textContent)) || '';
      return /生成任务已取消|任务已取消|生成任务取消/.test(text);
    });
  } catch (_err) {
    return false;
  }
}

async function hasGenerationErrorIndicator(page, selectors) {
  if (!page) return false;
  const indicators = selectors.generationErrorIndicators || [];
  if (indicators.length && await hasAnySelector(page, indicators)) return true;
  try {
    return await page.evaluate(() => {
      const text = (document.body && (document.body.innerText || document.body.textContent)) || '';
      return /生成中遇到错误|生成失败|生成任务失败|生成出现错误|任务失败/.test(text);
    });
  } catch (_err) {
    return false;
  }
}

async function maybeContinueGeneration(page, selectors, logger, options = {}) {
  if (!page) return false;
  const cancelled = await hasCancelIndicator(page, selectors);
  if (!cancelled) return false;
  if (logger) logger.warn('检测到生成任务已取消，尝试继续生成...');
  const continueSelectors = selectors.continueButton || [];
  if (continueSelectors.length) {
    const clicked = await clickFirstMatch(page, continueSelectors, logger);
    if (clicked) {
      await page.waitForTimeout(1000);
      return true;
    }
  }
  const promptInput = selectors.promptInput || [];
  const continuePrompt = String(options.continuePrompt || '继续');
  const promptMatch = await fillPrompt(page, promptInput, continuePrompt, logger);
  if (!promptMatch) return false;
  const sent = await submitGenerate(page, selectors, logger, options.generateButtonWaitMs);
  if (sent && logger) logger.info('已提交“继续”指令');
  return sent;
}

async function dismissLovartPopup(page, selectors, logger) {
  const indicators = selectors.popupIndicators || [];
  const closeSelectors = selectors.popupClose || [];
  let detected = false;
  if (indicators.length) {
    const hit = await waitForAnySelector(page, indicators, 2000);
    detected = Boolean(hit);
  }
  if (!detected && !closeSelectors.length) return false;
  if (!detected) {
    // 如果没有明确提示词，避免误点
    return false;
  }
  const closed = await clickFirstMatch(page, closeSelectors, logger);
  if (!closed) {
    try {
      await page.keyboard.press('Escape');
    } catch (_err) {
      // ignore
    }
  }
  await page.waitForTimeout(500);
  return true;
}

async function dismissBlockingOverlays(page, logger) {
  if (!page) return 0;
  try {
    const touched = await page.evaluate(() => {
      const selectors = [
        'div.mantine-Modal-overlay',
        'div.mantine-Overlay-root',
        'div[data-fixed="true"].mantine-Overlay-root',
        '[data-mantine-shared-portal-node="true"] .mantine-Overlay-root',
        'div[data-portal="true"][data-mantine-shared-portal-node="true"]',
        '[class*="Modal-overlay"]',
        '[class*="Overlay-root"]',
        '[data-fixed="true"]',
        '[class*="backdrop-blur"]',
        '.left-toolbar-position',
        '[class*="left-toolbar-position"]',
        '.right-panel',
        '[class*="right-panel"]',
        '.main-canvas-container',
        'div.relative.flex.h-full.w-full.flex-1.flex-col.items-stretch.overflow-clip'
      ];
      const nodes = [];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(node => nodes.push(node));
      });
      nodes.forEach(node => {
        node.style.pointerEvents = 'none';
        node.style.opacity = '0';
      });
      return nodes.length;
    });
    if (touched && logger) {
      logger.info(`已禁用遮挡层: ${touched}`);
    }
    return touched || 0;
  } catch (err) {
    if (logger) logger.warn(`禁用遮挡层失败: ${err.message}`);
    return 0;
  }
}

/**
 * 清理下载通知层（如"导出完成"），避免遮挡下载按钮
 * - 先确认 toast 存在，避免误操作
 * - 优先在 toast 容器内找关闭按钮（使用真实元素句柄）
 * - JS 禁用时处理所有匹配元素
 */
async function dismissDownloadToast(page, selectors, logger) {
  if (!page) return false;
  const toastSelectors = selectors.downloadToastNotification || [];
  const closeSelectors = selectors.downloadToastClose || [];

  await dismissBlockingOverlays(page, logger);

  // 0. 先判断 toast 是否存在（获取真实元素句柄）
  let toastHandle = null;
  if (toastSelectors.length > 0) {
    for (const sel of toastSelectors) {
      try {
        toastHandle = await page.$(sel);
        if (toastHandle) break;
      } catch (_err) {
        // 继续尝试下一个 selector
      }
    }
  }
  if (!toastHandle) {
    // 没有 toast，直接返回，不做任何操作
    return false;
  }

  let dismissed = false;

  // 方法1: 优先在 toast 容器内找关闭按钮（使用元素句柄）
  if (closeSelectors.length > 0) {
    try {
      const closedInside = await page.evaluate((toastEl, closeSelList) => {
        for (const closeSel of closeSelList) {
          const buttons = toastEl.querySelectorAll(closeSel);
          for (const btn of buttons) {
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      }, toastHandle, closeSelectors);
      if (closedInside) {
        if (logger) logger.info('已关闭下载通知层（容器内关闭按钮）');
        dismissed = true;
      }
    } catch (_err) {
      // 继续尝试其他方法
    }
  }

  // 方法2: 如果容器内没找到，尝试全局点击关闭按钮
  if (!dismissed && closeSelectors.length > 0) {
    try {
      const closedGlobal = await clickFirstMatch(page, closeSelectors, logger);
      if (closedGlobal) {
        if (logger) logger.info('已关闭下载通知层（全局关闭按钮）');
        dismissed = true;
      }
    } catch (_err) {
      // 继续
    }
  }

  // 方法3: 按 Escape 键（如果前面没成功）
  if (!dismissed) {
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      if (logger) logger.info('已尝试按 Escape 关闭通知层');
      dismissed = true;
    } catch (_err) {
      // 继续
    }
  }

  // 方法4: JavaScript 禁用所有匹配的 toast 元素（最后兜底）
  if (!dismissed && toastSelectors.length > 0) {
    try {
      const disabledCount = await page.evaluate((selList) => {
        let count = 0;
        for (const sel of selList) {
          const elements = document.querySelectorAll(sel);
          for (const el of elements) {
            if (el && el.parentNode) {
              el.style.pointerEvents = 'none';
              el.style.opacity = '0';
              count++;
            }
          }
        }
        return count;
      }, toastSelectors);
      if (disabledCount > 0) {
        if (logger) logger.info(`已禁用 ${disabledCount} 个下载通知层元素（pointer-events: none）`);
        dismissed = true;
      }
    } catch (_err) {
      // 继续
    }
  }

  if (dismissed) {
    await page.waitForTimeout(300);
  }
  return dismissed;
}

async function handleLovartNotFound(page, selectors, logger, baseUrl, navigationTimeout) {
  const indicators = selectors.errorIndicators || [];
  const backSelectors = selectors.backHomeButton || [];
  if (!indicators.length) return false;
  const hit = await waitForAnySelector(page, indicators, 2000);
  if (!hit) return false;
  if (logger) logger.warn('检测到 404 页面，尝试返回首页');
  const clicked = await clickFirstMatch(page, backSelectors, logger);
  if (clicked) {
    await page.waitForTimeout(1000);
    return true;
  }
  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  return true;
}

async function getMaxSelectorCount(page, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) return 0;
  let max = 0;
  for (const selector of selectors) {
    try {
      const count = await page.$$eval(selector, els => els.length);
      if (count > max) max = count;
    } catch (_err) {
      // ignore
    }
  }
  return max;
}

async function waitForResultItemsCount(page, selectors, expectedCount, timeoutMs, logger, abortSignal) {
  if (!expectedCount || !Array.isArray(selectors) || selectors.length === 0) return false;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  let lastCount = 0;
  while (Date.now() < deadline) {
    assertPageOpen(page);
    throwIfAborted(abortSignal, logger);
    const count = await getMaxSelectorCount(page, selectors);
    if (count !== lastCount && logger) {
      logger.info(`结果数量检测: ${count}/${expectedCount}`);
      lastCount = count;
    }
    if (count >= expectedCount) return true;
    await page.waitForTimeout(1000);
  }
  if (logger) {
    logger.warn(`结果数量不足 (${lastCount}/${expectedCount})，继续尝试下载`);
  }
  return false;
}

async function scrollResultPanels(page, logger) {
  if (!page) return false;
  try {
    const count = await page.evaluate(() => {
      const candidates = [];
      const elements = Array.from(document.querySelectorAll('div,section,main,aside,ul,ol'));
      const isScrollable = (el) => {
        const style = window.getComputedStyle(el);
        if (!style) return false;
        const overflowY = style.overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
        return el.scrollHeight > el.clientHeight + 20;
      };
      elements.forEach(el => {
        if (!isScrollable(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.height < 120 || rect.width < 200) return;
        candidates.push({ el, area: rect.height * rect.width });
      });
      if (candidates.length === 0) {
        window.scrollTo(0, document.body.scrollHeight);
        return 0;
      }
      candidates.sort((a, b) => b.area - a.area);
      const top = candidates.slice(0, 2);
      top.forEach(item => {
        item.el.scrollTop = item.el.scrollHeight;
      });
      return top.length;
    });
    if (logger && count > 0) {
      logger.info(`滚动结果列表: ${count}`);
    }
    return count > 0;
  } catch (err) {
    if (logger) logger.warn(`滚动结果列表失败: ${err.message}`);
    return false;
  }
}

async function collectAgentImageUrls(page) {
  if (!isCanvasPage(page)) return [];
  return page.evaluate(() => {
    const candidates = [];
    const seen = new Set();
    const agentPatterns = [
      /\/artifacts\/agent\//i,
      /\/sd-images\//i,
      /\/ai-images\//i
    ];

    const normalize = value => {
      if (!value) return '';
      const trimmed = String(value).trim();
      if (!trimmed) return '';
      if (/^(data:|blob:)/i.test(trimmed)) return '';
      if (!/^https?:/i.test(trimmed)) return '';
      return trimmed;
    };

    const isAgentUrl = url => agentPatterns.some(pattern => pattern.test(url));

    const pushUrl = url => {
      const base = url.split('?')[0];
      if (!base || seen.has(base)) return;
      seen.add(base);
      candidates.push(url);
    };

    document.querySelectorAll('img').forEach(img => {
      const sources = [
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.currentSrc
      ];
      const srcset = img.getAttribute('srcset') || '';
      srcset.split(',').forEach(part => sources.push(part.trim().split(' ')[0]));

      sources.forEach(raw => {
        const url = normalize(raw);
        if (!url) return;
        if (!isAgentUrl(url)) return;
        pushUrl(url);
      });
    });

    document.querySelectorAll('[style]').forEach(el => {
      const style = el.getAttribute('style') || '';
      if (!style.includes('url(')) return;
      const matches = style.match(/url\(([^)]+)\)/g) || [];
      matches.forEach(item => {
        const raw = item.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        const url = normalize(raw);
        if (!url) return;
        if (!isAgentUrl(url)) return;
        pushUrl(url);
      });
    });

    return candidates;
  });
}

async function collectResultImageStats(page) {
  if (!isCanvasPage(page)) return { visualCount: 0, summaryCount: 0 };
  return page.evaluate(() => {
    const seen = new Set();
    const minSize = 60;

    const normalize = value => {
      if (!value) return '';
      const trimmed = String(value).trim();
      if (!trimmed) return '';
      if (/^(data:|blob:)/i.test(trimmed)) return trimmed;
      if (!/^https?:/i.test(trimmed)) return '';
      return trimmed;
    };

    const pushUrl = url => {
      if (!url) return;
      const base = url.startsWith('http') ? url.split('?')[0] : url;
      if (!base || seen.has(base)) return;
      seen.add(base);
    };

    const isLarge = rect => rect && rect.width >= minSize && rect.height >= minSize;

    const collectFromSources = (sources, rect) => {
      if (!isLarge(rect)) return;
      sources.forEach(raw => {
        const url = normalize(raw);
        if (!url) return;
        pushUrl(url);
      });
    };

    document.querySelectorAll('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      const sources = [
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.currentSrc
      ];
      const srcset = img.getAttribute('srcset') || '';
      srcset.split(',').forEach(part => sources.push(part.trim().split(' ')[0]));
      collectFromSources(sources, rect);
    });

    document.querySelectorAll('[style]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (!isLarge(rect)) return;
      const style = el.getAttribute('style') || '';
      if (!style.includes('url(')) return;
      const matches = style.match(/url\(([^)]+)\)/g) || [];
      matches.forEach(item => {
        const raw = item.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        const url = normalize(raw);
        if (!url) return;
        pushUrl(url);
      });
    });

    let summaryCount = 0;
    const text = document.body ? document.body.innerText || '' : '';
    const patterns = [
      /共\s*(\d{1,3})\s*张/g,
      /(\d{1,3})\s*张(?:图片|图)/g,
      /共\s*(\d{1,3})\s*话/g,
      /(\d{1,3})\s*话/g
    ];
    const update = value => {
      const count = Number.parseInt(value, 10);
      if (!Number.isFinite(count)) return;
      if (count > 200) return;
      if (count > summaryCount) summaryCount = count;
    };
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        update(match[1]);
      }
    });

    return { visualCount: seen.size, summaryCount };
  });
}

function resolveEffectiveImageCount(urlCount, visualCount, _summaryCount) {
  const base = Math.max(Number(urlCount) || 0, Number(visualCount) || 0);
  if (!base) return 0;
  return base;
}


async function waitForAgentImagesCount(page, expectedCount, timeoutMs, logger, abortSignal) {
  if (!expectedCount) return { ok: false, count: 0, urls: [] };
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  let lastCount = 0;
  let lastChangeAt = Date.now();
  let lastScrollAt = 0;
  let lastUrls = [];
  while (Date.now() < deadline) {
    assertPageOpen(page);
    throwIfAborted(abortSignal, logger);
    const urls = await collectAgentImageUrls(page);
    let visualCount = 0;
    let summaryCount = 0;
    let count = urls.length;
    if (count < expectedCount) {
      const stats = await collectResultImageStats(page);
      visualCount = stats.visualCount || 0;
      summaryCount = stats.summaryCount || 0;
      count = resolveEffectiveImageCount(count, visualCount, summaryCount);
    }
    lastUrls = urls;
    if (count !== lastCount && logger) {
      logger.info(`生成图片数量检测: ${count}/${expectedCount} (url:${urls.length}, visual:${visualCount})`);
      lastCount = count;
      lastChangeAt = Date.now();
    }
    if (count >= expectedCount) return { ok: true, count, urls };
    if (count < expectedCount && Date.now() - lastChangeAt > 2000 && Date.now() - lastScrollAt > 3000) {
      const scrolled = await scrollResultPanels(page, logger);
      if (scrolled) {
        lastScrollAt = Date.now();
        await page.waitForTimeout(800);
      }
    }
    await page.waitForTimeout(1000);
  }
  if (logger) {
    logger.warn(`生成图片数量不足 (${lastCount}/${expectedCount})，继续尝试下载`);
  }
  return { ok: false, count: lastCount, urls: lastUrls };
}

async function waitForAgentImagesStable(page, expectedCount, minCount, timeoutMs, stableMs, logger, abortSignal) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  const minRequired = Number.isFinite(minCount) && minCount > 0
    ? Math.max(1, Math.floor(minCount))
    : 1;
  const stableWindow = Number.isFinite(stableMs) && stableMs > 0
    ? Math.max(3000, stableMs)
    : 8000;
  let lastCount = 0;
  let lastUrls = [];
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    assertPageOpen(page);
    throwIfAborted(abortSignal, logger);
    const urls = await collectAgentImageUrls(page);
    let visualCount = 0;
    let summaryCount = 0;
    let count = urls.length;
    if ((expectedCount && count < expectedCount) || count < minRequired) {
      const stats = await collectResultImageStats(page);
      visualCount = stats.visualCount || 0;
      summaryCount = stats.summaryCount || 0;
      count = resolveEffectiveImageCount(count, visualCount, summaryCount);
    }
    lastUrls = urls;
    if (count != lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
      if (logger) {
        const targetLabel = expectedCount ? expectedCount : minRequired;
        logger.info(`生成图片数量检测: ${count}/${targetLabel} (url:${urls.length}, visual:${visualCount})`);
      }
    }
    if (expectedCount && count >= expectedCount) {
      return { ok: true, count, urls, reason: 'target' };
    }
    if (count >= minRequired && (Date.now() - lastChangeAt) >= stableWindow) {
      if (logger) logger.info(`生成图片数量已稳定 (${count})`);
      return { ok: true, count, urls, reason: 'stable' };
    }
    await page.waitForTimeout(1000);
  }
  if (logger) {
    logger.warn(`生成图片等待超时 (${lastCount}/${minRequired})`);
  }
  return { ok: lastCount >= minRequired, count: lastCount, urls: lastUrls, reason: 'timeout' };
}
async function scrollPageTop(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (_err) {
    // ignore
  }
  try {
    await page.keyboard.press('Home');
  } catch (_err) {
    // ignore
  }
}

async function ensureFitToScreen(page, selectors, logger) {
  try {
    await page.keyboard.press('Escape');
  } catch (_err) {
    // ignore
  }

  await focusCanvas(page, selectors, logger);

  const combos = ['Shift+1', 'Meta+1', 'Control+1'];
  for (const combo of combos) {
    try {
      await page.keyboard.press(combo);
      await page.waitForTimeout(150);
    } catch (_err) {
      // ignore
    }
  }
  if (logger) logger.info('已尝试快捷键适合屏幕');

  const fitSelectors = selectors && selectors.fitToScreenItem ? selectors.fitToScreenItem : [];
  const clickFitIfVisible = async () => {
    if (!fitSelectors.length) return false;
    const match = await waitForAnyHandle(page, fitSelectors, 2000);
    if (!match || !match.handle) return false;
    try {
      await match.handle.click({ timeout: 2000 });
      if (logger) logger.info('已点击适合屏幕');
      return true;
    } catch (err) {
      if (logger) logger.warn(`点击适合屏幕失败: ${err.message}`);
      return false;
    }
  };

  const tryOpenMenu = async action => {
    try {
      await action();
    } catch (_err) {
      return false;
    }
    await page.waitForTimeout(200);
    return await clickFitIfVisible();
  };

  const menuSelectors = selectors && selectors.zoomMenuButton ? selectors.zoomMenuButton : [];
  let applied = false;
  if (menuSelectors.length) {
    const menuHandle = await findFirstHandle(page, menuSelectors);
    if (menuHandle && menuHandle.handle) {
      const ok = await tryOpenMenu(() => menuHandle.handle.click({ timeout: 3000 }));
      applied = applied || ok;
    }
  }

  const okByPercent = await tryOpenMenu(async () => {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button,div,span'))
        .filter(el => el && /\d+%/.test(el.textContent || ''));
      if (!candidates.length) return false;
      const sorted = candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (ra.top !== rb.top) return ra.top - rb.top;
        return rb.right - ra.right;
      });
      const target = sorted[0];
      const clickable = target.closest('button') || target.closest('[role="button"]') || target;
      if (!clickable) return false;
      clickable.click();
      return true;
    });
    if (!clicked) throw new Error('percent_not_found');
  });
  applied = applied || okByPercent;

  if (!applied) {
    const okByCoord = await tryOpenMenu(async () => {
      let viewport = page.viewportSize ? page.viewportSize() : null;
      if (!viewport || !viewport.width) {
        viewport = await page.evaluate(() => ({
          width: window.innerWidth || 0,
          height: window.innerHeight || 0
        }));
      }
      if (!viewport || !viewport.width) throw new Error('viewport_not_found');
      const x = Math.max(20, viewport.width - 140);
      const y = 60;
      await page.mouse.click(x, y);
      if (logger) logger.info('已点击缩放控件区域');
    });
    applied = applied || okByCoord;
  }
  return applied;
}

async function ensureCanvasSelection(page, selectors, logger) {
  if (await hasSelectionToolbar(page)) {
    if (logger) logger.info('检测到选择工具条，跳过全选步骤');
    return;
  }
  await focusCanvas(page, selectors, logger);
  await clickCanvasPoints(page, selectors, logger);
  await pressSelectAll(page);
  await page.waitForTimeout(200);
  if (await hasSelectionToolbar(page)) {
    if (logger) logger.info('已执行全选');
    return;
  }
  await pressSelectTool(page, logger);
  await dragSelectCanvas(page, selectors, logger);
  await page.waitForTimeout(300);
  if (await hasSelectionToolbar(page)) {
    if (logger) logger.info('全选未生效，拖拽框选成功');
    return;
  }
  const shiftSelected = await tryShiftSelectThumbnails(page, logger);
  if (shiftSelected) {
    await page.waitForTimeout(200);
    if (await hasSelectionToolbar(page)) {
      if (logger) logger.info('Shift 连选成功');
      return;
    }
  }
  if (logger) logger.warn('全选失败，继续尝试下载将被跳过');
}

async function dragSelectCanvas(page, selectors, logger) {
  try {
    const box = await page.evaluate((selList) => {
      const selectors = (selList || []).length ? selList : ['div.konvajs-content', 'canvas'];
      let el = null;
      for (const sel of selectors) {
        const candidate = document.querySelector(sel);
        if (candidate) {
          el = candidate;
          break;
        }
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }, selectors && selectors.canvasContainer ? selectors.canvasContainer : []);
    if (!box) return false;
    const startX = Math.max(10, box.left + 10);
    const startY = Math.max(10, box.top + 10);
    const endX = Math.max(startX + 20, box.right - 10);
    const endY = Math.max(startY + 20, box.bottom - 10);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();
    return true;
  } catch (err) {
    if (logger) logger.warn(`拖拽框选失败: ${err.message}`);
    return false;
  }
}

async function findToolbarDownloadHandle(page, selectors, logger) {
  try {
    const toolbarButtons = await collectToolbarButtonHandles(page, logger);
    if (toolbarButtons.length) {
      for (const handle of toolbarButtons) {
        try {
          const label = await handle.evaluate(el => `${el.getAttribute('aria-label') || ''} ${el.title || ''} ${(el.textContent || '').trim()}`.trim());
          if (/下载|导出|download|export/i.test(label)) {
            if (logger) logger.info(`工具栏下载按钮命中(label): ${label}`);
            return handle;
          }
        } catch (_err) {
          // ignore
        }
      }
      const rightmost = await pickRightmostHandle(toolbarButtons);
      if (rightmost) {
        if (logger) logger.info('工具栏下载按钮命中(右侧优先)');
        return rightmost;
      }
    }
  } catch (err) {
    if (logger) logger.warn(`工具栏按钮优先策略失败: ${err.message}`);
  }
  const toolbarSelectors = selectors && selectors.downloadToolbarButton ? selectors.downloadToolbarButton : [];
  if (toolbarSelectors.length) {
    try {
      const handles = [];
      for (const sel of toolbarSelectors) {
        const list = await page.$$(sel);
        list.forEach(item => handles.push(item));
      }
      if (handles.length) {
        const winner = await pickRightmostHandle(handles);
        if (winner) return winner;
      }
    } catch (err) {
      if (logger) logger.warn(`查找下载按钮候选失败: ${err.message}`);
    }
  }
  try {
    const handle = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const matcher = btn => {
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.title || ''} ${btn.textContent || ''}`.trim();
        return /下载|导出|download|export/i.test(label);
      };
      return buttons.find(matcher) || null;
    });
    const element = handle.asElement();
    if (element) return element;
    await handle.dispose();
  } catch (err) {
    if (logger) logger.warn(`查找工具栏下载按钮失败: ${err.message}`);
  }
  try {
    const handle = await page.evaluateHandle(() => {
      const bars = Array.from(document.querySelectorAll('div,section'))
        .filter(el => /创建编组|合并图层/.test(el.textContent || '') ||
          (el.className || '').includes('border-panel'));
      const bar = bars[0];
      if (!bar) return null;
      const buttons = Array.from(bar.querySelectorAll('button'))
        .filter(btn => btn && btn.offsetParent !== null);
      if (!buttons.length) return null;
      const scored = buttons.map(btn => {
        const cls = btn.className || '';
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.title || ''} ${(btn.textContent || '').trim()}`.trim();
        const rect = btn.getBoundingClientRect();
        let score = 0;
        if (/下载|导出|download|export/i.test(label)) score += 10;
        if (cls.includes('rounded-lg')) score += 5;
        if (cls.includes('gap-1')) score += 3;
        if (btn.querySelector('svg')) score += 1;
        return { btn, score, right: rect.right, top: rect.top };
      });
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
        return b.right - a.right;
      });
      return scored[0] ? scored[0].btn : null;
    });
    const element = handle.asElement();
    if (element) return element;
    await handle.dispose();
  } catch (err) {
    if (logger) logger.warn(`查找工具栏下载按钮失败(文本栏): ${err.message}`);
  }
  return null;
}

async function collectToolbarDownloadCandidates(page, selectors, logger) {
  const candidates = [];
  const seen = new Set();
  const pushHandle = async (handle) => {
    if (!handle) return;
    try {
      const box = await handle.boundingBox();
      if (!box) {
        candidates.push(handle);
        return;
      }
      const key = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(handle);
    } catch (_err) {
      candidates.push(handle);
    }
  };

  try {
    const toolbarButtons = await collectToolbarButtonHandles(page, logger);
    if (toolbarButtons.length) {
      const infos = await Promise.all(toolbarButtons.map(async handle => {
        try {
          const label = await handle.evaluate(el => `${el.getAttribute('aria-label') || ''} ${el.title || ''} ${(el.textContent || '').trim()}`.trim());
          const box = await handle.boundingBox();
          return { handle, label, box };
        } catch (_err) {
          return { handle, label: '', box: null };
        }
      }));
      const downloadCandidates = infos.filter(item => /下载|导出|download|export/i.test(item.label || ''));
      for (const item of downloadCandidates) {
        await pushHandle(item.handle);
      }
      const sortedByRight = infos
        .slice()
        .filter(item => item.box)
        .sort((a, b) => {
          const rightA = a.box ? a.box.x + a.box.width : 0;
          const rightB = b.box ? b.box.x + b.box.width : 0;
          if (rightB !== rightA) return rightB - rightA;
          return (a.box ? a.box.y : 0) - (b.box ? b.box.y : 0);
        });
      for (const item of sortedByRight) {
        await pushHandle(item.handle);
      }
    }
  } catch (err) {
    if (logger) logger.warn(`工具栏候选收集失败: ${err.message}`);
  }

  const toolbarSelectors = selectors && selectors.downloadToolbarButton ? selectors.downloadToolbarButton : [];
  if (toolbarSelectors.length) {
    for (const sel of toolbarSelectors) {
      try {
        const handles = await page.$$(sel);
        for (const handle of handles) {
          await pushHandle(handle);
        }
      } catch (_err) {
        // ignore
      }
    }
  }

  try {
    const handle = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
      const matcher = btn => {
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.title || ''} ${btn.textContent || ''}`.trim();
        return /下载|导出|download|export/i.test(label);
      };
      return buttons.find(matcher) || null;
    });
    const element = handle.asElement();
    if (element) {
      await pushHandle(element);
    } else {
      await handle.dispose();
    }
  } catch (_err) {
    // ignore
  }

  if (!candidates.length) {
    const fallback = await findToolbarDownloadHandle(page, selectors, logger);
    if (fallback) candidates.push(fallback);
  }

  return candidates;
}

async function logToolbarButtons(page, logger) {
  if (!logger) return;
  try {
    const info = await page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll('div,section'))
        .filter(el => /创建编组|合并图层/.test(el.textContent || '') ||
          (el.className || '').includes('border-panel'));
      const bar = bars[0];
      if (!bar) return [];
      return Array.from(bar.querySelectorAll('button')).map(btn => ({
        text: (btn.textContent || '').trim(),
        aria: btn.getAttribute('aria-label') || '',
        title: btn.getAttribute('title') || '',
        class: btn.className || ''
      }));
    });
    if (info && info.length) {
      info.slice(0, 12).forEach((item, idx) => {
        logger.info(`工具栏按钮[${idx}] text="${item.text}" aria="${item.aria}" title="${item.title}" class="${item.class}"`);
      });
    } else {
      logger.info('未检测到工具栏按钮列表');
    }
  } catch (err) {
    logger.warn(`读取工具栏按钮失败: ${err.message}`);
  }
}

async function collectToolbarButtonHandles(page, logger) {
  try {
    const barHandle = await page.evaluateHandle(() => {
      const bars = Array.from(document.querySelectorAll('div,section'))
        .filter(el => /创建编组|合并图层/.test(el.textContent || '') ||
          (el.className || '').includes('border-panel'));
      return bars[0] || null;
    });
    const bar = barHandle.asElement();
    if (!bar) {
      await barHandle.dispose();
      return [];
    }
    const buttons = await bar.$$('button');
    if (buttons.length) return buttons;
    const roleButtons = await bar.$$('[role="button"]');
    return roleButtons;
  } catch (err) {
    if (logger) logger.warn(`获取工具栏按钮句柄失败: ${err.message}`);
    return [];
  }
}

function rankToolbarButton(info, index) {
  const cls = info.className || '';
  if (cls.includes('rounded-lg') && cls.includes('gap-1')) return 10 + index;
  if (cls.includes('ant-dropdown-trigger')) return 5 + index;
  if (cls.includes('reset-svg')) return 2 + index;
  if (!info.text && !info.aria && !info.title) return 1 + index;
  return 0 + index;
}

async function tryToolbarDownload(page, selectors, logger, downloadTimeout) {
  await logToolbarButtons(page, logger);
  const handles = await collectToolbarButtonHandles(page, logger);
  if (!handles.length) return null;

  const infos = await Promise.all(handles.map(async (handle, idx) => {
    try {
      const info = await handle.evaluate(el => ({
        text: (el.textContent || '').trim(),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        className: el.className || ''
      }));
      const box = await handle.boundingBox();
      return {
        handle,
        idx,
        info,
        box,
        right: box ? (box.x + box.width) : 0,
        top: box ? box.y : 0
      };
    } catch (_err) {
      return { handle, idx, info: { text: '', aria: '', title: '', className: '' }, box: null, right: 0, top: 0 };
    }
  }));

  const downloadCandidates = infos.filter(item => {
    const label = `${item.info.text} ${item.info.aria} ${item.info.title}`.trim();
    return /下载|导出|download|export/i.test(label);
  });
  const sortedByRight = infos
    .slice()
    .filter(item => item.box)
    .sort((a, b) => {
      if (b.right !== a.right) return b.right - a.right;
      return a.top - b.top;
    });

  const ordered = [];
  downloadCandidates.forEach(item => ordered.push(item));
  sortedByRight.forEach(item => {
    if (!ordered.find(existing => existing.handle === item.handle)) {
      ordered.push(item);
    }
  });
  if (!ordered.length) return null;

  const attemptList = ordered.slice(0, 2);
  for (const item of attemptList) {
    let downloadPromise = null;
    try {
      downloadPromise = page.waitForEvent('download', { timeout: downloadTimeout });
      await item.handle.click({ timeout: 2000 });
      if (selectors && selectors.downloadMenuItem) {
        const menuHit = await waitForAnySelector(page, selectors.downloadMenuItem, 1500);
        if (menuHit) {
          await clickFirstMatch(page, selectors.downloadMenuItem, logger);
        }
      }
      const download = await downloadPromise;
      return download;
    } catch (_err) {
      if (downloadPromise) {
        downloadPromise.catch(() => {});
      }
      // try next candidate
    }
  }
  return null;
}

async function cleanupLovartCanvasPages(context, currentPage, logger) {
  if (!context) return;
  try {
    const pages = getAllContextPages(context);
    for (const page of pages) {
      if (page === currentPage) continue;
      const url = page.url() || '';
      if (/lovart\.ai\/canvas/i.test(url)) {
        try {
          await page.close({ runBeforeUnload: false });
          if (logger) logger.info('已关闭多余 Lovart canvas 页面');
        } catch (_err) {
          // ignore
        }
      }
    }
  } catch (_err) {
    // ignore
  }
}

async function downloadImageFromUrl(page, url, targetPath, logger, timeoutMs, abortSignal) {
  throwIfAborted(abortSignal, logger);
  const candidates = [];
  const cleaned = url.split('?')[0];
  if (cleaned) candidates.push(cleaned);
  if (!candidates.includes(url)) candidates.push(url);

  const requestClient = page && page.request ? page.request : null;
  const proxyUrl = process.env.LOVART_PROXY_URL ||
    process.env.GEMINI_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(5000, Math.floor(timeoutMs))
    : 60000;

  for (const candidate of candidates) {
    try {
      let buffer = null;
      if (requestClient) {
        for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
          try {
            const response = await requestClient.get(candidate, {
              timeout: requestTimeout,
              headers: {
                referer: page.url()
              }
            });
            if (response && response.ok()) {
              buffer = await response.body();
            } else if (logger && response) {
              logger.warn(`直链请求失败: ${response.status()} ${candidate}`);
            }
          } catch (err) {
            if (logger) logger.warn(`直链请求异常: ${err.message}`);
          }
          if (!buffer && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }

      if (!buffer) {
        for (let attempt = 0; attempt < 3 && !buffer; attempt++) {
          try {
            const response = await axios.get(candidate, {
              responseType: 'arraybuffer',
              proxy: false,
              httpsAgent,
              timeout: requestTimeout,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': page ? page.url() : 'https://www.lovart.ai/'
              }
            });
            if (!response || response.status < 200 || response.status >= 300) continue;
            buffer = Buffer.from(response.data);
          } catch (err) {
            if (logger) logger.warn(`Axios 下载失败: ${err.message}`);
          }
          if (!buffer && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
          }
        }
      }

      if (!buffer || !buffer.length) {
        const ext = path.extname(candidate).toLowerCase() || '.png';
        const tempPath = targetPath.replace(/\.png$/i, '') + `_raw${ext}`;
        try {
          const curlArgs = [
            '-L',
            '-o',
            tempPath,
            '--retry',
            '8',
            '--retry-delay',
            '2',
            '--retry-all-errors',
            '--retry-connrefused',
            '--connect-timeout',
            '10',
            '--max-time',
            String(Math.ceil(requestTimeout / 1000)),
          ];
          if (proxyUrl) {
            curlArgs.push('--proxy', proxyUrl);
          }
          curlArgs.push(
            '-H',
            `Referer: ${page ? page.url() : 'https://www.lovart.ai/'}`,
            '-A',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            candidate
          );
          try {
            execFileSync('curl', curlArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
          } catch (err) {
            const detail = err && err.stderr ? String(err.stderr) : '';
            throw new Error(detail || err.message);
          }
          if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
            const finalPath = await convertToPng(tempPath, targetPath, logger);
            return finalPath;
          }
        } catch (err) {
          if (logger) logger.warn(`curl 下载失败: ${err.message}`);
        }
        continue;
      }
      const ext = path.extname(candidate).toLowerCase() || '.png';
      const tempPath = targetPath.replace(/\.png$/i, '') + `_raw${ext}`;
      fs.writeFileSync(tempPath, buffer);
      const finalPath = await convertToPng(tempPath, targetPath, logger);
      return finalPath;
    } catch (_err) {
      // try next candidate
    }
  }
  return '';
}


async function downloadImagesWithConcurrency({
  page,
  urls,
  outputDir,
  expectedCount,
  logger,
  concurrency,
  minSuccessCount,
  timeoutMs,
  downloadUntilExpected,
  deadlineMs,
  abortSignal
}) {
  const count = Number.isFinite(expectedCount) ? Math.max(0, Math.floor(expectedCount)) : 0;
  const results = Array.from({ length: count }, () => ({ ok: false, error: '缺少图片链接' }));
  if (!count) return results;
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 0;
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.min(8, Math.floor(concurrency))) : 4;
  let cursor = 0;
  const stopAt = (!downloadUntilExpected && Number.isFinite(minSuccessCount) && minSuccessCount > 0)
    ? Math.max(1, Math.min(minSuccessCount, count))
    : 0;
  let successCount = 0;
  let stopLogged = false;
  const workers = Array.from({ length: limit }, () => (async () => {
    while (true) {
      if (deadline && Date.now() > deadline) break;
      throwIfAborted(abortSignal, logger);
      if (stopAt && successCount >= stopAt) break;
      const index = cursor;
      cursor += 1;
      if (index >= count) break;
      if (deadline && Date.now() > deadline) break;
      if (stopAt && successCount >= stopAt) break;
      const url = urls && urls[index] ? urls[index] : '';
      if (!url) {
        results[index] = { ok: false, error: '缺少图片链接' };
        continue;
      }
      const targetPath = path.join(outputDir, `${padIndex(index + 1)}.png`);
      if (fs.existsSync(targetPath)) {
        results[index] = {
          ok: true,
          filePath: targetPath,
          downloadedAt: new Date().toISOString()
        };
        successCount += 1;
        if (stopAt && successCount >= stopAt && logger && !stopLogged) {
          stopLogged = true;
          logger.info(`已达到最小完成数量 (${successCount}/${stopAt})，停止继续下载`);
        }
        continue;
      }
      const saved = await downloadImageFromUrl(page, url, targetPath, logger, timeoutMs, abortSignal);
      if (saved) {
        results[index] = {
          ok: true,
          filePath: saved,
          downloadedAt: new Date().toISOString()
        };
        successCount += 1;
        if (stopAt && successCount >= stopAt && logger && !stopLogged) {
          stopLogged = true;
          logger.info(`已达到最小完成数量 (${successCount}/${stopAt})，停止继续下载`);
        }
      } else {
        results[index] = { ok: false, error: '下载图片链接失败' };
      }
    }
  })());
  await Promise.all(workers);
  return results;
}


async function findFirstHandle(page, selectors, options = {}) {
  if (!Array.isArray(selectors)) return null;
  const allowHidden = options.allowHidden === true;
  for (const selector of selectors) {
    let handles = [];
    try {
      handles = await page.$$(selector);
    } catch (_err) {
      handles = [];
    }
    for (const handle of handles) {
      if (!allowHidden) {
        try {
          const box = await handle.boundingBox();
          if (!box) continue;
        } catch (_err) {
          continue;
        }
      }
      return { selector, handle };
    }
  }
  return null;
}

async function clickFirstMatch(page, selectors, logger) {
  assertPageOpen(page);
  await suppressIntercomOverlay(page, logger);
  await dismissBlockingOverlays(page, logger);
  const match = await findFirstHandle(page, selectors);
  if (!match) return false;
  try {
    await match.handle.scrollIntoViewIfNeeded();
  } catch (_err) {
    // ignore
  }
  try {
    await match.handle.click({ timeout: 10000 });
    return true;
  } catch (err) {
    if (logger) logger.warn(`点击失败: ${match.selector} (${err.message})`);
  }
  try {
    await page.keyboard.press('Escape');
  } catch (_err) {
    // ignore
  }
  try {
    await match.handle.click({ timeout: 10000, force: true });
    if (logger) logger.info(`强制点击成功: ${match.selector}`);
    return true;
  } catch (err) {
    if (logger) logger.warn(`强制点击失败: ${match.selector} (${err.message})`);
  }
  return false;
}

async function isEditableElement(handle) {
  try {
    return await handle.evaluate(el => {
      if (el.isContentEditable) return true;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'file' || type === 'hidden') return false;
        return !el.readOnly && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }
      return false;
    });
  } catch (_err) {
    return false;
  }
}

async function findFileInputHandle(page, selectors) {
  if (!Array.isArray(selectors)) return null;
  const frames = [];
  try {
    frames.push(page.mainFrame());
  } catch (_err) {
    // ignore
  }
  try {
    frames.push(...page.frames());
  } catch (_err) {
    // ignore
  }
  const seen = new Set();
  for (const frame of frames) {
    if (!frame || seen.has(frame)) continue;
    seen.add(frame);
    for (const selector of selectors) {
      let handles = [];
      try {
        handles = await frame.$$(selector);
      } catch (_err) {
        handles = [];
      }
      for (const handle of handles) {
        return { selector, handle };
      }
    }
  }
  return null;
}

async function findEditableHandle(page, selectors) {
  if (!Array.isArray(selectors)) return null;
  const frames = [];
  try {
    frames.push(page.mainFrame());
  } catch (_err) {
    // ignore
  }
  try {
    frames.push(...page.frames());
  } catch (_err) {
    // ignore
  }
  const uniqueFrames = [];
  const seenFrames = new Set();
  for (const frame of frames) {
    if (!frame || seenFrames.has(frame)) continue;
    seenFrames.add(frame);
    uniqueFrames.push(frame);
  }

  let fallback = null;
  for (const frame of uniqueFrames) {
    for (const selector of selectors) {
      let handles = [];
      try {
        handles = await frame.$$(selector);
      } catch (_err) {
        handles = [];
      }
      for (const handle of handles) {
        try {
          const editable = await isEditableElement(handle);
          if (!editable) continue;
          try {
            await handle.scrollIntoViewIfNeeded();
          } catch (_err) {
            // ignore
          }
          const box = await handle.boundingBox().catch(() => null);
          if (box) {
            return { selector, handle };
          }
          if (!fallback) fallback = { selector, handle };
        } catch (_err) {
          // ignore
        }
      }
    }
  }
  return fallback;
}

async function clickGenerateButton(page, selectors, logger, timeoutMs) {
  assertPageOpen(page);
  await suppressIntercomOverlay(page, logger);
  const match = await findFirstHandle(page, selectors);
  if (!match) return false;
  const { handle, selector } = match;
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  try {
    await handle.scrollIntoViewIfNeeded();
    await handle.evaluate(el => {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    await page.waitForTimeout(200);
  } catch (_err) {
    // ignore
  }
  try {
    await handle.waitForElementState('visible', { timeout: waitMs });
    await handle.waitForElementState('enabled', { timeout: waitMs });
  } catch (err) {
    if (logger) logger.warn(`生成按钮不可用: ${selector} (${err.message})`);
    return false;
  }
  try {
    await handle.click({ timeout: waitMs });
    return true;
  } catch (err) {
    if (logger) logger.warn(`生成按钮点击失败: ${selector} (${err.message})`);
  }
  return false;
}

async function submitGenerate(page, selectors, logger, timeoutMs) {
  const clicked = await clickGenerateButton(page, selectors.generateButton || selectors, logger, timeoutMs);
  if (clicked) return true;
  const promptMatch = await findEditableHandle(page, selectors.promptInput || []);
  if (!promptMatch) return false;
  try {
    await promptMatch.handle.click({ timeout: 1000 });
  } catch (_err) {
    // ignore
  }
  try {
    await page.keyboard.press('Enter');
    if (logger) logger.info('已尝试通过回车提交提示词');
    return true;
  } catch (_err) {
    return false;
  }
}

async function clickForFileChooser(page, selectors, timeoutMs, logger) {
  if (!Array.isArray(selectors) || selectors.length === 0) return null;
  for (const selector of selectors) {
    assertPageOpen(page);
    await suppressIntercomOverlay(page, logger);
    await dismissBlockingOverlays(page, logger);
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: timeoutMs }).catch(() => null);
      try {
        await handle.scrollIntoViewIfNeeded();
      } catch (_err) {
        // ignore
      }
      try {
        await handle.waitForElementState('visible', { timeout: timeoutMs || 8000 });
        await handle.waitForElementState('enabled', { timeout: timeoutMs || 8000 });
      } catch (_err) {
        // ignore
      }
      let clicked = false;
      try {
        await handle.click({ timeout: timeoutMs || 8000 });
        clicked = true;
      } catch (err) {
        if (logger) logger.warn(`点击失败: ${selector} (${err.message})`);
      }
      if (!clicked) {
        try {
          await page.keyboard.press('Escape');
        } catch (_err) {
          // ignore
        }
        try {
          await handle.click({ timeout: 8000, force: true });
          clicked = true;
          if (logger) logger.info(`强制点击成功: ${selector}`);
        } catch (err) {
          if (logger) logger.warn(`强制点击失败: ${selector} (${err.message})`);
        }
      }
      const fileChooser = await fileChooserPromise;
      if (fileChooser) return fileChooser;
    }
  }
  return null;
}

async function fillPrompt(page, selectors, promptText, logger) {
  const match = await findEditableHandle(page, selectors);
  if (!match) {
    throw new Error('未找到提示词输入框，请确认已登录且右侧输入框可见');
  }

  const { selector, handle } = match;
  const tagName = await handle.evaluate(el => el.tagName.toLowerCase());
  const isEditable = await handle.evaluate(el => !!el.isContentEditable);

  if (tagName === 'textarea' || tagName === 'input') {
    await handle.fill(promptText);
  } else {
    await dismissBlockingOverlays(page, logger);
    try {
      await handle.click({ timeout: 10000 });
    } catch (err) {
      if (logger) logger.warn(`提示词输入框点击失败，尝试强制点击: ${err.message}`);
      await handle.click({ timeout: 5000, force: true });
    }
    try {
      await page.keyboard.press('Control+A');
    } catch (_err) {
      await page.keyboard.press('Meta+A');
    }
    await page.keyboard.insertText(promptText);
  }

  if (logger) {
    logger.info(`提示词已写入 (${isEditable ? 'contenteditable' : tagName})`);
  }
  return match;
}

async function setProjectName(page, selectors, projectName, logger) {
  const name = String(projectName || '').trim();
  if (!name) return false;
  const inputSelectors = selectors.projectNameInput || [];
  if (!inputSelectors.length) return false;
  await waitForAnySelector(page, inputSelectors, 2000);
  let match = await findFirstHandle(page, inputSelectors);
  if (!match && selectors.projectNameDisplay) {
    await clickFirstMatch(page, selectors.projectNameDisplay, logger);
    await page.waitForTimeout(500);
    await waitForAnySelector(page, inputSelectors, 2000);
    match = await findFirstHandle(page, inputSelectors);
  }
  if (!match) {
    if (logger) logger.warn('未找到项目名称输入框，跳过命名');
    return false;
  }

  const { selector, handle } = match;
  try {
    await handle.scrollIntoViewIfNeeded();
  } catch (_err) {
    // ignore
  }

  const tagName = await handle.evaluate(el => el.tagName.toLowerCase());
  const editable = await handle.evaluate(el => {
    if (el.isContentEditable) return true;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      return !el.readOnly && !el.disabled;
    }
    return false;
  });

  if (!editable) {
    if (logger) logger.warn('项目名称输入框不可编辑，跳过命名');
    return false;
  }

  try {
    if (tagName === 'textarea' || tagName === 'input') {
      await page.fill(selector, name);
    } else {
      await handle.click({ timeout: 10000 });
      await pressSelectAll(page);
      await page.keyboard.insertText(name);
    }
  } catch (err) {
    if (logger) logger.warn(`项目命名失败，跳过: ${err.message || err}`);
    return false;
  }

  if (logger) {
    logger.info(`项目名称已设置 (${tagName})`);
  }
  return true;
}

async function getPromptTextFromHandle(handle) {
  const tagName = await handle.evaluate(el => el.tagName.toLowerCase());
  const isEditable = await handle.evaluate(el => !!el.isContentEditable);
  if (tagName === 'textarea' || tagName === 'input') {
    const value = await handle.evaluate(el => el.value || '');
    return String(value || '');
  }
  if (isEditable) {
    const value = await handle.evaluate(el => el.innerText || el.textContent || '');
    return String(value || '');
  }
  return '';
}

async function ensurePromptFilled(page, selectors, logger, preferredHandle) {
  if (preferredHandle) {
    const preferredText = (await getPromptTextFromHandle(preferredHandle)).trim();
    if (preferredText) return true;
  }
  const match = await findEditableHandle(page, selectors);
  if (!match) return false;
  const text = (await getPromptTextFromHandle(match.handle)).trim();
  if (text) return true;
  if (logger) logger.warn('提示词为空，取消生成');
  return false;
}

async function maybeResubmitPrompt(page, selectors, promptText, styleRefPath, logger, referenceUploadTimeout, generateButtonWaitMs, forceResubmit = false) {
  const hasHistory = await hasPromptHistory(page, selectors, logger);
  await page.waitForTimeout(1500);
  try {
    const existingImages = await collectAgentImageUrls(page);
    if (existingImages && existingImages.length) {
      if (logger) logger.info('检测到生成图片链接，跳过重填');
      return false;
    }
  } catch (_err) {
    // ignore
  }
  if (!forceResubmit) {
    const activitySelectors = [
      ...(selectors.busyIndicators || []),
      ...(selectors.downloadAllButton || []),
      ...(selectors.downloadButtons || []),
      ...(selectors.doneIndicators || [])
    ];
    const hasActivity = await hasAnySelector(page, activitySelectors);
    if (hasActivity) {
      if (logger) logger.info('检测到生成/下载状态，跳过重填');
      return false;
    }
  }

  let promptMatch = await findEditableHandle(page, selectors.promptInput || []);
  if (!promptMatch) {
    for (let attempt = 0; attempt < 3 && !promptMatch; attempt++) {
      await page.waitForTimeout(1000);
      promptMatch = await findEditableHandle(page, selectors.promptInput || []);
    }
  }
  if (!promptMatch) {
    if (logger) logger.warn('未找到提示词输入框，无法重填');
    return false;
  }

  const existingText = (await getPromptTextFromHandle(promptMatch.handle)).trim();
  if (hasHistory && existingText && logger) {
    logger.info('检测到提示词历史，尝试重新提交');
  }
  await dismissLovartPopup(page, selectors, logger);
  const textToUse = promptText || existingText;
  if (!textToUse) {
    if (logger) logger.warn('提示词为空，无法重新提交');
    return false;
  }
  if (styleRefPath) {
    await uploadReferenceImage(page, selectors, styleRefPath, logger, referenceUploadTimeout);
  }
  await fillPrompt(page, selectors.promptInput, textToUse, logger);

  const submitted = await submitGenerate(page, selectors, logger, generateButtonWaitMs);
  if (submitted && logger) {
    logger.info('已重新提交提示词');
  }
  return submitted;
}

async function uploadReferenceImage(page, selectors, filePath, logger, timeoutMs) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`参考图不存在: ${filePath}`);
  }

  if (selectors.referenceTab) {
    await clickFirstMatch(page, selectors.referenceTab, logger);
  }
  let inputMatch = await findFileInputHandle(
    page,
    selectors.referenceFileInput || ['input[type="file"]']
  );
  if (inputMatch && inputMatch.handle) {
    try {
      await inputMatch.handle.setInputFiles(filePath);
      if (logger) logger.info('参考图已上传（input 直写）');
      return;
    } catch (err) {
      if (logger) logger.warn(`参考图直写失败，改用 filechooser: ${err.message}`);
    }
  }

  let fileChooser = null;
  if (selectors.referenceButton) {
    const buttonSelectors = Array.isArray(selectors.referenceButton)
      ? selectors.referenceButton.slice(0, 4)
      : selectors.referenceButton;
    const chooserTimeout = Number.isFinite(timeoutMs) ? Math.min(timeoutMs, 2500) : 2500;
    fileChooser = await clickForFileChooser(page, buttonSelectors, chooserTimeout, logger);
  }

  if (fileChooser) {
    await fileChooser.setFiles(filePath);
    if (logger) logger.info('参考图已上传（filechooser）');
    return;
  }

  if (logger) {
    logger.warn('参考图上传未触发 filechooser，跳过参考图');
  }
  return;

  if (!inputMatch) {
    inputMatch = await findFileInputHandle(
      page,
      selectors.referenceFileInput || ['input[type="file"]']
    );
  }
  if (!inputMatch) {
    throw new Error('未找到参考图上传输入框，请更新 lovart.selectors.json');
  }

  await inputMatch.handle.setInputFiles(filePath);
  if (logger) {
    logger.info('参考图已上传');
  }
}

function padIndex(index) {
  return String(index).padStart(3, '0');
}

function resolveMinimumSuccessCount(expectedCount) {
  const count = Number.isFinite(expectedCount) ? Math.floor(expectedCount) : 0;
  if (!count) return 1;
  const ratio = 0.7;
  return Math.max(1, Math.ceil(count * ratio));
}

async function convertToPng(sourcePath, targetPath, logger) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.png') {
    fs.renameSync(sourcePath, targetPath);
    return targetPath;
  }

  await sharp(sourcePath).png().toFile(targetPath);
  fs.unlinkSync(sourcePath);
  if (logger) {
    logger.info(`图片已转换为 PNG: ${path.basename(targetPath)}`);
  }
  return targetPath;
}

function listFilesRecursively(dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return header[0] === 0x50 && header[1] === 0x4b;
  } catch (_err) {
    return false;
  }
}

function isDownloadCandidateFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return false;
  if (lower.endsWith('.crdownload') || lower.endsWith('.tmp') || lower.endsWith('.download')) {
    return false;
  }
  const ext = path.extname(lower);
  return ['.zip', '.png', '.jpg', '.jpeg', '.webp'].includes(ext);
}

async function waitForStableFile(filePath, logger) {
  try {
    const first = fs.statSync(filePath);
    if (!first.isFile() || first.size === 0) return false;
    await new Promise(resolve => setTimeout(resolve, 800));
    const second = fs.statSync(filePath);
    return second.isFile() && second.size === first.size && second.size > 0;
  } catch (err) {
    if (logger) logger.warn(`检测下载文件稳定性失败: ${err.message}`);
    return false;
  }
}

async function waitForDownloadOnDisk(downloadDir, startedAt, timeoutMs, logger) {
  if (!downloadDir) return '';
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Date.now() + 60000;
  const minMtime = startedAt ? startedAt - 1000 : Date.now() - 60000;
  let loggedInProgress = false;
  while (Date.now() < deadline) {
    let entries = [];
    try {
      entries = fs.readdirSync(downloadDir);
    } catch (err) {
      if (logger) logger.warn(`读取下载目录失败: ${err.message}`);
      return '';
    }
    const inProgress = new Set();
    entries.forEach(name => {
      if (String(name).toLowerCase().endsWith('.crdownload')) {
        inProgress.add(name.replace(/\.crdownload$/i, ''));
      }
    });
    if (inProgress.size > 0 && logger && !loggedInProgress) {
      logger.info(`检测到下载进行中(.crdownload): ${Array.from(inProgress).slice(0, 5).join(', ')}`);
      loggedInProgress = true;
    }
    const candidates = [];
    for (const name of entries) {
      if (!isDownloadCandidateFilename(name)) continue;
      if (inProgress.has(name)) continue;
      const fullPath = path.join(downloadDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < minMtime) continue;
        candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
      } catch (_err) {
        // ignore
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      const stable = await waitForStableFile(candidate.fullPath, logger);
      if (stable) return candidate.fullPath;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (logger) logger.warn('未在下载目录检测到新文件');
  return '';
}

function resolveDownloadDir(options, selectorsConfig, logger) {
  const explicit = options.downloadDir || selectorsConfig.download_dir || process.env.LOVART_DOWNLOAD_DIR || '';
  let candidate = explicit;
  if (!candidate) {
    const defaultDir = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(defaultDir)) {
      candidate = defaultDir;
    }
  }
  if (!candidate) return '';
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    if (explicit && logger) {
      logger.warn(`下载目录不存在: ${resolved}`);
    }
    return '';
  }
  return resolved;
}

async function handleZipDownload(zipPath, outputDir, expectedCount, logger) {
  const unzipDir = path.join(outputDir, 'unzipped');
  ensureDir(unzipDir);
  let images = [];
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', unzipDir], { stdio: 'ignore' });
    images = listFilesRecursively(unzipDir).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    });
  } catch (err) {
    if (logger) logger.warn(`解压失败，尝试使用 bsdtar: ${err.message}`);
    try {
      execFileSync('bsdtar', ['-xf', zipPath, '-C', unzipDir], { stdio: 'ignore' });
      images = listFilesRecursively(unzipDir).filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
      });
    } catch (tarErr) {
      if (logger) logger.warn(`bsdtar 解压失败，改用逐条读取: ${tarErr.message}`);
      images = [];
    }
  }

  if (!images.length) {
    try {
      const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      const entries = listing
        .split('\n')
        .map(line => line.trim())
        .filter(line => line);
      let index = 0;
      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
        index += 1;
        const rawBuffer = execFileSync('unzip', ['-p', zipPath, entry], { env: { ...process.env, LC_ALL: 'C' } });
        if (!rawBuffer || !rawBuffer.length) continue;
        const tempPath = path.join(unzipDir, `entry_${index}${ext}`);
        fs.writeFileSync(tempPath, rawBuffer);
        images.push(tempPath);
      }
    } catch (innerErr) {
      throw new Error(`解压失败，请检查 unzip 命令: ${innerErr.message}`);
    }
  }

  images.sort();

  const results = Array.from({ length: expectedCount }, () => ({ ok: false, error: '缺少图片' }));

  for (let i = 0; i < expectedCount; i++) {
    if (!images[i]) continue;
    const targetPath = path.join(outputDir, `${padIndex(i + 1)}.png`);
    await convertToPng(images[i], targetPath, logger);
    results[i] = {
      ok: true,
      filePath: targetPath,
      downloadedAt: new Date().toISOString()
    };
  }

  return results;
}

async function downloadFromHandle(page, handle, targetPath, timeoutMs, logger, downloadDir, selectors) {
  assertPageOpen(page);
  const startedAt = Date.now();
  const diskTimeout = Math.max(timeoutMs || 0, 30000);
  const attemptClick = async (clicker, label) => {
    let downloadPromise = null;
    try {
      downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
      await clicker();
      if (selectors && selectors.downloadMenuItem) {
        const menuHit = await waitForAnySelector(page, selectors.downloadMenuItem, 5000);
        if (menuHit) {
          if (logger) logger.info('检测到下载菜单，尝试点击');
          await clickFirstMatch(page, selectors.downloadMenuItem, logger);
        }
      }
      const download = await downloadPromise;
      return download;
    } catch (err) {
      if (downloadPromise) {
        downloadPromise.catch(() => {});
      }
      if (isElementDetachedError(err)) {
        const detached = new Error('HANDLE_DETACHED');
        detached.code = 'HANDLE_DETACHED';
        throw detached;
      }
      if (logger) logger.warn(`触发下载失败 (${label}): ${err.message}`);
      return null;
    }
  };

  let download = null;
  try {
    await handle.scrollIntoViewIfNeeded();
  } catch (_err) {
    // ignore
  }

  let pointerDisabled = false;
  try {
    pointerDisabled = (await disableCanvasPointerEvents(page, logger)) > 0;

    // 清理可能遮挡的下载通知层
    if (selectors) {
      await dismissDownloadToast(page, selectors, logger);
    }

    download = await attemptClick(
      () => {
        return page.evaluate(el => {
          el.click();
        }, handle);
      },
      'click'
    );

    if (!download) {
      // 再次尝试清理通知层（可能重新出现）
      if (selectors) {
        await dismissDownloadToast(page, selectors, logger);
      }
      download = await attemptClick(
        () => {
          return page.evaluate(el => {
            el.click();
          }, handle);
        },
        'force-click'
      );
    }

    if (!download) {
      // 最后一次清理并尝试 evaluate click
      if (selectors) {
        await dismissDownloadToast(page, selectors, logger);
      }
      download = await attemptClick(
        () => handle.evaluate(el => el.click()),
        'evaluate-click'
      );
    }

    let diskPath = '';
    if (!download && downloadDir) {
      diskPath = await waitForDownloadOnDisk(downloadDir, startedAt, diskTimeout, logger);
    }
    if (!download && !diskPath) {
      throw new Error('下载按钮点击失败');
    }

    let tempPath = '';
    if (download) {
      const suggestedName = download.suggestedFilename() || `lovart_${Date.now()}`;
      const ext = path.extname(suggestedName) || '.bin';
      tempPath = path.join(path.dirname(targetPath), `raw_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
      try {
        await download.saveAs(tempPath);
        if (logger) logger.info(`下载文件已保存到: ${tempPath}（Chrome 下载记录可能显示已删除）`);
      } catch (err) {
        if (logger) logger.warn(`download.saveAs 失败: ${err.message}`);
        if (downloadDir) {
          const fallbackDisk = await waitForDownloadOnDisk(downloadDir, startedAt, diskTimeout, logger);
          if (fallbackDisk) {
            const fallbackExt = path.extname(fallbackDisk) || ext;
            tempPath = path.join(path.dirname(targetPath), `raw_${Date.now()}_${Math.random().toString(16).slice(2)}${fallbackExt}`);
            fs.copyFileSync(fallbackDisk, tempPath);
            if (logger) logger.info(`已从下载目录兜底捕获文件: ${path.basename(fallbackDisk)}`);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    } else if (diskPath) {
      const ext = path.extname(diskPath) || '.bin';
      tempPath = path.join(path.dirname(targetPath), `raw_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
      fs.copyFileSync(diskPath, tempPath);
      if (logger) logger.info(`已从下载目录捕获文件: ${path.basename(diskPath)}`);
    }

    if (isZipFile(tempPath)) {
      return { zipPath: tempPath };
    }

    try {
      const finalPath = await convertToPng(tempPath, targetPath, logger);
      return { filePath: finalPath };
    } catch (err) {
      throw new Error(`下载文件不是有效图片: ${err.message}`);
    }
  } finally {
    if (pointerDisabled) {
      await restoreCanvasPointerEvents(page, logger);
    }
  }
}

async function collectDownloadButtons(page, selectors, expectedCount) {
  if (!Array.isArray(selectors) || selectors.length === 0) return [];
  let fallback = [];
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    if (handles.length >= expectedCount) return handles;
    if (!fallback.length && handles.length) {
      fallback = handles;
    }
  }
  return fallback;
}

async function refreshCanvasUrl(page, logger, timeoutMs, note) {
  if (!page) return { canvasUrl: '', projectId: '' };
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  try {
    if (!/projectId=/.test(page.url())) {
      await page.waitForURL(/projectId=/, { timeout });
    }
  } catch (_err) {
    // ignore
  }
  const canvasUrl = page.url();
  const projectId = extractProjectIdFromUrl(canvasUrl);
  if (logger && projectId) {
    logger.info(`ProjectId 已更新${note ? ` (${note})` : ''}: ${projectId}`);
  }
  return { canvasUrl, projectId };
}

async function captureDebug(page, outputDir, stepName, logger) {
  const filename = `debug_${stepName}.png`;
  const filePath = path.join(outputDir, filename);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    if (logger) logger.info(`已保存截图: ${filename}`);
  } catch (err) {
    if (logger) logger.warn(`截图失败: ${err.message}`);
  }
}

async function runLovartBatch(options) {
  const outputDir = options.outputDir;
  ensureDir(outputDir);

  const logPath = options.logPath || path.join(outputDir, 'run.log');
  const logger = options.logger || new Logger(logPath);
  const abortSignal = options.abortSignal || null;

  const selectorsConfig = loadSelectors(options.configPath);
  const selectors = selectorsConfig.selectors || {};
  const timeouts = selectorsConfig.timeouts || {};
  const preferDirectDownload = options.preferDirectDownload != null
    ? options.preferDirectDownload
    : selectorsConfig.prefer_direct_download === true;
  const requireFullResults = options.requireFullResults != null
    ? options.requireFullResults
    : selectorsConfig.require_full_results === true;
  const requireDownloadAll = options.requireDownloadAll != null
    ? options.requireDownloadAll
    : selectorsConfig.require_download_all === true;
  const resumeExistingProject = options.resumeExistingProject === true;
  const navigationTimeout = timeouts.navigation_ms || 60000;
  const loginTimeout = timeouts.login_ms || 900000;
  const processTimeoutMs = Number.isFinite(timeouts.process_ms) && timeouts.process_ms > 0
    ? Math.floor(timeouts.process_ms)
    : 1800000;
  const fullWaitDefaultMs = Number.isFinite(timeouts.full_wait_ms) && timeouts.full_wait_ms > 0
    ? Math.floor(timeouts.full_wait_ms)
    : 1200000;
  const generateTimeout = Number.isFinite(timeouts.generate_ms) && timeouts.generate_ms > 0
    ? timeouts.generate_ms
    : processTimeoutMs;
  const downloadTimeout = timeouts.download_ms || 60000;
  const downloadStageTimeoutMs = Number.isFinite(timeouts.download_stage_ms) && timeouts.download_stage_ms > 0
    ? Math.floor(timeouts.download_stage_ms)
    : 8 * 60 * 1000;
  const resultWaitTimeout = Number.isFinite(timeouts.result_wait_ms) && timeouts.result_wait_ms > 0
    ? timeouts.result_wait_ms
    : 180000;
  const generateStartTimeout = Number.isFinite(timeouts.generate_start_wait_ms)
    ? timeouts.generate_start_wait_ms
    : 60000;
  const cdpConnectTimeoutMs = Number.isFinite(timeouts.cdp_connect_ms) && timeouts.cdp_connect_ms > 0
    ? Math.max(10000, Math.floor(timeouts.cdp_connect_ms))
    : 120000;
  const cdpConnectRetryCount = Number.isFinite(timeouts.cdp_connect_retry_count) && timeouts.cdp_connect_retry_count >= 0
    ? Math.min(3, Math.floor(timeouts.cdp_connect_retry_count))
    : 1;
  const cdpConnectRetryWaitMs = Number.isFinite(timeouts.cdp_connect_retry_wait_ms) && timeouts.cdp_connect_retry_wait_ms > 0
    ? Math.max(500, Math.floor(timeouts.cdp_connect_retry_wait_ms))
    : 2000;
  const referenceUploadTimeout = Number.isFinite(timeouts.reference_upload_ms)
    ? timeouts.reference_upload_ms
    : 8000;
  const generateButtonWaitMs = Number.isFinite(timeouts.generate_button_wait_ms)
    ? timeouts.generate_button_wait_ms
    : 30000;
  const canvasWaitTimeout = Number.isFinite(timeouts.canvas_wait_ms) && timeouts.canvas_wait_ms > 0
    ? Math.floor(timeouts.canvas_wait_ms)
    : Math.min(generateTimeout, 120000);
  const canvasRetryLimit = Number.isFinite(timeouts.canvas_retry_count) && timeouts.canvas_retry_count > 0
    ? Math.min(3, Math.floor(timeouts.canvas_retry_count))
    : 1;
  const zeroImageRetryWindowMs = Number.isFinite(timeouts.zero_image_retry_ms) && timeouts.zero_image_retry_ms > 0
    ? Math.floor(timeouts.zero_image_retry_ms)
    : 60000;
  const zeroImagePollSliceMs = Number.isFinite(timeouts.zero_image_poll_ms) && timeouts.zero_image_poll_ms > 0
    ? Math.max(5000, Math.floor(timeouts.zero_image_poll_ms))
    : 30000;
  const zeroImageAbortMs = Number.isFinite(timeouts.zero_image_abort_ms) && timeouts.zero_image_abort_ms > 0
    ? Math.max(30000, Math.floor(timeouts.zero_image_abort_ms))
    : 300000;
  let downloadDir = resolveDownloadDir(options, selectorsConfig, logger);
  if (options.outputDir) {
    const outputRoot = path.resolve(options.outputDir, '..', '..');
    const articleDownloadDir = path.resolve(outputRoot, '_downloads');
    ensureDir(articleDownloadDir);
    if (downloadDir && downloadDir !== articleDownloadDir && logger) {
      logger.info(`下载目录切换: ${downloadDir} -> ${articleDownloadDir}`);
    }
    downloadDir = articleDownloadDir;
  }
  if (downloadDir && logger) {
    logger.info(`下载目录监控启用: ${downloadDir}`);
  }

  const directDownloadConcurrency = Number.isFinite(options.directDownloadConcurrency)
    ? Math.max(1, Math.floor(options.directDownloadConcurrency))
    : (Number.isFinite(selectorsConfig.direct_download_concurrency) && selectorsConfig.direct_download_concurrency > 0
      ? Math.max(1, Math.floor(selectorsConfig.direct_download_concurrency))
      : 4);
  const cappedDirectDownloadConcurrency = Math.min(8, directDownloadConcurrency);

  const directDownloadTimeoutMs = Number.isFinite(options.directDownloadTimeoutMs)
    ? Math.max(5000, Math.floor(options.directDownloadTimeoutMs))
    : (Number.isFinite(selectorsConfig.direct_download_timeout_ms) && selectorsConfig.direct_download_timeout_ms > 0
      ? Math.max(5000, Math.floor(selectorsConfig.direct_download_timeout_ms))
      : 60000);
  const directDownloadStageMs = Number.isFinite(options.directDownloadStageMs)
    ? Math.max(5000, Math.floor(options.directDownloadStageMs))
    : (Number.isFinite(timeouts.direct_download_stage_ms) && timeouts.direct_download_stage_ms > 0
      ? Math.max(5000, Math.floor(timeouts.direct_download_stage_ms))
      : Math.min(downloadStageTimeoutMs, 120000));

  const downloadUntilExpected = options.downloadUntilExpected != null
    ? options.downloadUntilExpected
    : true;

  const browserConfig = selectorsConfig.browser || {};
  const browserMode = String(options.browserMode || browserConfig.mode || '').toLowerCase();

  const bitConfig = selectorsConfig.bitbrowser || {};
  const useBitBrowser = options.useBitBrowser === true ||
    (options.useBitBrowser !== false && (bitConfig.enabled === true || bitConfig.enabled === 'true'));
  const useCdp = !useBitBrowser && (browserMode === 'cdp' || browserMode === 'remote');
  const usePersistent = !useBitBrowser && !useCdp && (browserMode === 'chrome' || browserMode === 'persistent');
  const sharedCdp = options.sharedCdp != null
    ? options.sharedCdp
    : (browserConfig.shared_cdp === true || String(process.env.LOVART_SHARED_CDP || '').toLowerCase() === 'true');
  const protectExternalPages = useCdp && sharedCdp;
  const keepOpen = options.keepOpen != null ? options.keepOpen : (browserConfig.keep_open === true);
  const reusePage = options.reusePage != null ? options.reusePage : (browserConfig.reuse_page === true);
  const closeExistingCanvasPages = options.closeExistingCanvasPages != null
    ? options.closeExistingCanvasPages
    : selectorsConfig.close_existing_canvas_pages === true;
  const effectiveReusePage = reusePage;
  const effectiveCloseExistingCanvasPages = closeExistingCanvasPages;
  const closePagesOnDone = options.closePagesOnDone != null
    ? options.closePagesOnDone
    : (options.closeCanvasOnDone != null ? options.closeCanvasOnDone : true);
  const userDataDir = path.resolve(
    process.cwd(),
    options.userDataDir || browserConfig.user_data_dir || '.auth/lovart_chrome'
  );
  const browserChannel = options.browserChannel || browserConfig.channel || '';
  const browserExecutablePath = options.browserExecutablePath || browserConfig.executable_path || '';
  const cdpUrl = options.cdpUrl || browserConfig.cdp_url || process.env.LOVART_CDP_URL || 'http://127.0.0.1:9888';
  const autoStartCdp = options.autoStartCdp != null
    ? options.autoStartCdp
    : (browserConfig.cdp_auto_start === true || String(process.env.LOVART_CDP_AUTO_START || '').toLowerCase() === 'true');
  const effectiveAutoStartCdp = protectExternalPages ? false : autoStartCdp;
  const cdpExecutablePath = options.cdpExecutablePath ||
    browserConfig.cdp_executable_path ||
    process.env.LOVART_CDP_EXECUTABLE_PATH ||
    process.env.CHROME_EXECUTABLE_PATH ||
    '';
  const bitProfileId = options.bitProfileId ||
    bitConfig.profile_id ||
    process.env.LOVART_BITBROWSER_PROFILE_ID ||
    process.env.BITBROWSER_PROFILE_ID ||
    '';
  const bitApiBase = normalizeBaseUrl(
    options.bitApiBase ||
    bitConfig.api_base ||
    process.env.BITBROWSER_API_BASE ||
    process.env.BIT_API_BASE ||
    process.env.BITBROWSER_API ||
    'http://127.0.0.1:54345'
  );
  const bitApiToken = options.bitApiToken ||
    bitConfig.api_token ||
    process.env.BITBROWSER_API_TOKEN ||
    process.env.BITBROWSER_API_KEY ||
    '';
  const bitApiHeaders = options.bitApiHeaders || {};
  const closeOnDone = options.closeOnDone != null
    ? options.closeOnDone
    : (bitConfig.close_on_done !== false);

  const storagePath = options.storagePath
    ? path.resolve(process.cwd(), options.storagePath)
    : path.resolve(process.cwd(), '.auth/lovart.json');

  ensureDir(path.dirname(storagePath));

  const results = Array.from({ length: options.expectedCount || 0 }, () => ({
    ok: false,
    error: '未开始'
  }));

  const resetResults = () => {
    for (let i = 0; i < results.length; i++) {
      results[i] = { ok: false, error: '未开始' };
    }
  };
  const maxZeroImageRetries = Number.isFinite(timeouts.zero_image_retry_count) && timeouts.zero_image_retry_count > 0
    ? Math.min(3, Math.floor(timeouts.zero_image_retry_count))
    : 1;
  let zeroImageRetryCount = 0;
  const processStartedAt = Date.now();

  const projectName = String(options.projectName || '').trim();
  const existingCanvasUrl = String(options.existingCanvasUrl || '').trim();
  const existingProjectId = String(options.existingProjectId || '').trim();

  let browser;
  let context;
  let page;
  let originPage = null;
  let canvasUrl = '';
  let projectId = '';
  let projectNameApplied = false;
  let stepIndex = 1;
  const shouldCloseBrowser = useBitBrowser ? closeOnDone : (useCdp ? false : !keepOpen);
  const ownedPages = new Set();
  const onGenerationStarted = typeof options.onGenerationStarted === 'function'
    ? options.onGenerationStarted
    : null;
  let generationStartedNotified = false;
  const notifyGenerationStarted = async () => {
    if (!onGenerationStarted || generationStartedNotified) return;
    generationStartedNotified = true;
    try {
      await onGenerationStarted({ canvasUrl, projectId });
    } catch (_err) {
      // ignore
    }
  };
  try {
    if (useBitBrowser) {
      if (!bitProfileId) {
        throw new Error('缺少 BitBrowser profileId，请配置 lovart.selectors.json 或环境变量');
      }
      logger.info(`启动 BitBrowser (profile: ${bitProfileId})...`);
      const ws = await openBitBrowserProfile({
        apiBase: bitApiBase,
        apiToken: bitApiToken,
        apiHeaders: bitApiHeaders,
        profileId: bitProfileId
      });
      browser = await chromium.connectOverCDP(ws);
      const contexts = browser.contexts();
      context = contexts[0] || (await browser.newContext({
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        ignoreHTTPSErrors: true
      }));
      const existingPage = effectiveReusePage ? pickExistingPage(context, { lovartOnly: protectExternalPages }) : null;
      page = existingPage || (await context.newPage());
      if (!existingPage) ownedPages.add(page);
      originPage = page;
    } else if (useCdp) {
      if (protectExternalPages && logger) {
        logger.info('共享 CDP 模式：仅复用/清理 Lovart 页面，不影响其它标签页');
      }
      if (effectiveAutoStartCdp) {
        await ensureCdpReady({ cdpUrl, userDataDir, executablePath: cdpExecutablePath, logger });
      }
      logger.info(`连接现有 Chrome (CDP): ${cdpUrl}`);
      const connectAndOpen = async () => {
        browser = await chromium.connectOverCDP(cdpUrl, { timeout: cdpConnectTimeoutMs });
        const contexts = browser.contexts();
        context = contexts[0] || null;
        if (!context) {
          try {
            context = await browser.newContext({
              viewport: { width: 1280, height: 800 },
              acceptDownloads: true,
              ignoreHTTPSErrors: true
            });
          } catch (_err) {
            context = null;
          }
        }
        if (!context) {
          throw new Error('CDP_NO_CONTEXT');
        }
        const existingPage = effectiveReusePage ? pickExistingPage(context, { lovartOnly: protectExternalPages }) : null;
        page = existingPage || (await context.newPage());
        if (!existingPage) ownedPages.add(page);
        originPage = page;
      };
      try {
        await connectAndOpen();
      } catch (err) {
        let lastError = err;
        for (let attempt = 0; attempt < cdpConnectRetryCount; attempt += 1) {
          if (logger) logger.warn(`CDP 连接异常，尝试重连 (${attempt + 1}/${cdpConnectRetryCount}): ${lastError.message || lastError}`);
          try {
        await refreshPageIfBlank(page, logger);
            if (browser && typeof browser.close === 'function') {
              await browser.close();
            }
          } catch (_err) {
            // ignore
          }
          if (cdpConnectRetryWaitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, cdpConnectRetryWaitMs));
          }
          try {
            await connectAndOpen();
            lastError = null;
            break;
          } catch (innerErr) {
            lastError = innerErr;
          }
        }
        if (lastError) {
          if (isPageClosedError(lastError) || isFrameDetachedError(lastError) || lastError.message === 'CDP_NO_CONTEXT') {
            throw lastError;
          }
          throw lastError;
        }
      }
    } else if (usePersistent) {
      ensureDir(userDataDir);
      logger.info(`启动持久化浏览器 (${browserChannel || 'chromium'})...`);
      context = await getPersistentContext({
        userDataDir,
        headless: options.headless === true,
        channel: browserChannel,
        executablePath: browserExecutablePath,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ],
        logger,
        reuse: keepOpen === true
      });
      browser = context.browser();
      const existingPage = effectiveReusePage ? pickExistingPage(context, { lovartOnly: protectExternalPages }) : null;
      page = existingPage || (await context.newPage());
      if (!existingPage) ownedPages.add(page);
      originPage = page;
    } else {
      logger.info('启动浏览器...');
      browser = await chromium.launch({
        headless: options.headless === true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      });

      const contextOptions = {
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        ignoreHTTPSErrors: true
      };

      if (fs.existsSync(storagePath)) {
        contextOptions.storageState = storagePath;
        logger.info(`加载 storageState: ${storagePath}`);
      }

      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      ownedPages.add(page);
      originPage = page;
    }
    page.setDefaultTimeout(30000);
    if (downloadDir) {
      await applyDownloadBehavior(context, page, downloadDir, logger);
    }

    const baseUrl = selectorsConfig.base_url || DEFAULT_BASE_URL;
    const createUrl = selectorsConfig.create_url || baseUrl || DEFAULT_BASE_URL;
    const resolvedExistingCanvasUrl = existingCanvasUrl || (existingProjectId ? `${baseUrl.replace(/\/$/, '')}/canvas?projectId=${existingProjectId}&agent=1` : '');
    const preferExistingCanvas = Boolean(resolvedExistingCanvasUrl);
    const reuseCanvas = effectiveReusePage && isCanvasPage(page);
    const openExistingCanvas = async (targetUrl, reason) => {
      if (logger) {
        const note = reason ? `(${reason})` : '';
        logger.info(`复用已有项目${note}: ${targetUrl}`);
      }
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      } catch (err) {
        if (isPageClosedError(err) || isFrameDetachedError(err)) {
          logger.warn(`画布页面失效，改用新标签页打开: ${err.message}`);
          const fresh = await context.newPage();
          ownedPages.add(fresh);
          page = fresh;
          page.setDefaultTimeout(30000);
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
        } else {
          throw err;
        }
      }
    };

    if (reuseCanvas && preferExistingCanvas) {
      const currentUrl = page.url();
      const currentProjectId = extractProjectIdFromUrl(currentUrl || '');
      const targetProjectId = extractProjectIdFromUrl(resolvedExistingCanvasUrl || '');
      const sameProject = currentProjectId && targetProjectId && currentProjectId === targetProjectId;
      if (!sameProject) {
        await openExistingCanvas(resolvedExistingCanvasUrl, '切换到锁定项目');
      } else {
        logger.info('复用已有 canvas 页面');
      }
    } else if (reuseCanvas && !preferExistingCanvas) {
      logger.info('检测到已有 canvas，返回创作页以创建新项目');
      try {
        await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      } catch (err) {
        if (isPageClosedError(err) || isFrameDetachedError(err)) {
          logger.warn(`返回创作页失败，改用新标签页: ${err.message}`);
          const fresh = await context.newPage();
          ownedPages.add(fresh);
          page = fresh;
          page.setDefaultTimeout(30000);
          await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
        } else {
          throw err;
        }
      }
    } else if (resolvedExistingCanvasUrl) {
      await openExistingCanvas(resolvedExistingCanvasUrl, '锁定项目');
    } else {
      logger.info(`打开 Lovart 页面: ${createUrl}`);
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (isPageClosedError(err) || isFrameDetachedError(err)) {
            logger.warn(`主页页面失效，改用新标签页打开: ${err.message}`);
            const fresh = await context.newPage();
            ownedPages.add(fresh);
            page = fresh;
            page.setDefaultTimeout(30000);
            continue;
          }
          if (/ERR_CONNECTION_RESET|ECONNRESET|net::ERR/i.test(String(err && err.message ? err.message : err))) {
            logger.warn(`主页连接异常，稍后重试: ${err.message}`);
            await page.waitForTimeout(1500 * (attempt + 1));
            continue;
          }
          throw err;
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    }
    if (effectiveCloseExistingCanvasPages && context) {
      for (const existingPage of context.pages()) {
        if (existingPage !== page && isCanvasPage(existingPage)) {
          await existingPage.close().catch(() => {});
        }
      }
      if (!reuseCanvas && isCanvasPage(page)) {
        await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
      }
    }
    stepIndex += 1;

    await handleLovartNotFound(page, selectors, logger, baseUrl, navigationTimeout);

    let promptSelector = await waitForAnySelector(page, selectors.promptInput, 3000);
    if (!promptSelector && selectors.createEntry) {
      const popupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
      await clickFirstMatch(page, selectors.createEntry, logger);
      const popupPage = await popupPromise;
      if (popupPage) {
        ownedPages.add(popupPage);
        page = popupPage;
        page.setDefaultTimeout(30000);
        await page.waitForLoadState('domcontentloaded', { timeout: navigationTimeout }).catch(() => {});
      }
    }

    await dismissLovartPopup(page, selectors, logger);

    if (!promptSelector) {
      promptSelector = await waitForAnySelector(page, selectors.promptInput, 15000);
    }
    if (!promptSelector && selectors.loginIndicators) {
      const loginHit = await waitForAnySelector(page, selectors.loginIndicators, 5000);
      if (loginHit) {
        logger.warn('检测到登录界面，请手动完成登录/验证');
        if (selectors.guardIndicators) {
          const guardHit = await waitForAnySelector(page, selectors.guardIndicators, 5000);
          if (guardHit) {
            logger.warn('检测到安全验证，请在页面完成验证后继续');
          }
        }
        promptSelector = await waitForAnySelector(page, selectors.promptInput, loginTimeout);
      }
    }

    if (!promptSelector) {
      await dismissLovartPopup(page, selectors, logger);
      await handleLovartNotFound(page, selectors, logger, baseUrl, navigationTimeout);
      promptSelector = await waitForAnySelector(page, selectors.promptInput, 5000);
    }

    let skipPromptCheck = false;
    if (!promptSelector && preferExistingCanvas && isCanvasPage(page)) {
      skipPromptCheck = true;
      if (logger) logger.warn('未检测到提示词输入框，但已有 canvas URL，继续尝试下载');
    }

    if (!promptSelector && !skipPromptCheck) {
      await captureDebug(page, outputDir, `step_${stepIndex}_no_prompt`, logger);
      throw new Error('未检测到提示词输入框，请确认已登录且右侧输入框可见');
    }

    if (!useBitBrowser && !usePersistent && !useCdp) {
      await context.storageState({ path: storagePath });
      logger.info(`storageState 已保存: ${storagePath}`);
    } else {
      logger.info('持久化浏览器/BitBrowser/CDP 模式不保存 storageState');
    }
    stepIndex += 1;

    let canvasPage = null;
    let skipGeneration = false;
    const forceSkipGeneration = skipPromptCheck;
    const existingCanvasPages = new Set(
      getAllContextPages(context).filter(pageItem => isCanvasPage(pageItem) && pageItem !== page)
    );
    const canvasIgnoreProjectIds = new Set(
      Array.from(existingCanvasPages)
        .map(pageItem => {
          try {
            return extractProjectIdFromUrl(pageItem.url());
          } catch (_err) {
            return '';
          }
        })
        .filter(Boolean)
    );
    if (resolvedExistingCanvasUrl) {
      if (isCanvasPage(page)) {
        canvasPage = page;
        claimCanvasPage(canvasPage);
        skipGeneration = true;
      } else {
        try {
          await page.waitForURL(/lovart\.ai\/canvas/i, { timeout: 5000 });
        } catch (_err) {
          // ignore
        }
        if (isCanvasPage(page)) {
          canvasPage = page;
          claimCanvasPage(canvasPage);
          skipGeneration = true;
        }
      }
      if (!skipGeneration && isCanvasPage(page)) {
        try {
          const urls = await collectAgentImageUrls(page);
          if (urls && urls.length) {
            canvasPage = page;
            claimCanvasPage(canvasPage);
            skipGeneration = true;
            if (logger) logger.info(`已检测到生成图片 (${urls.length})，复用现有项目`);
          }
        } catch (_err) {
          // ignore
        }
      }
      if (skipGeneration) {
        const activitySelectors = [
          ...(selectors.busyIndicators || []),
          ...(selectors.downloadAllButton || []),
          ...(selectors.downloadButtons || []),
          ...(selectors.doneIndicators || [])
        ];
        const hasHistory = await hasPromptHistory(canvasPage || page, selectors, logger);
        const hasActivity = hasHistory || await hasAnySelector(canvasPage || page, activitySelectors);
        if (!hasActivity) {
          skipGeneration = false;
          if (logger) logger.warn('已有项目未检测到生成/结果，重新生成');
        }
      }
      if (!skipGeneration && logger) {
        logger.warn('已有项目未进入 canvas，继续新建');
      }
    }

    if (forceSkipGeneration && isCanvasPage(page)) {
      canvasPage = page;
      claimCanvasPage(canvasPage);
      skipGeneration = true;
      if (logger) logger.info('未检测到提示词输入框，直接复用现有 canvas');
    }

    if (!skipGeneration) {
      if (options.styleRefPath) {
        await uploadReferenceImage(page, selectors, options.styleRefPath, logger, referenceUploadTimeout);
      }
      stepIndex += 1;
      const promptMatch = await fillPrompt(page, selectors.promptInput, options.prompt, logger);
      stepIndex += 1;

      let promptOk = await ensurePromptFilled(page, selectors.promptInput, logger, promptMatch && promptMatch.handle);
      if (!promptOk) {
        await page.waitForTimeout(500);
        const retryMatch = await fillPrompt(page, selectors.promptInput, options.prompt, logger);
        promptOk = await ensurePromptFilled(page, selectors.promptInput, logger, retryMatch && retryMatch.handle);
      }
      if (!promptOk) {
        throw new Error('提示词为空，停止生成');
      }

      await dismissLovartPopup(page, selectors, logger);

      if (!selectors.generateButton) {
        throw new Error('未配置生成按钮 selectors.generateButton');
      }
      const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
      const clicked = await submitGenerate(page, selectors, logger, generateButtonWaitMs);
      if (!clicked) {
        throw new Error('生成按钮不可点击，请检查页面是否完成输入或被弹层遮挡');
      }
      logger.info('已点击生成，等待结果...');
      stepIndex += 1;

      const signalTimeout = Math.max(20000, Math.min(45000, generateStartTimeout * 3));
      const signalOk = await waitForGenerationSignal(page, selectors, signalTimeout, logger);
      if (!signalOk) {
        logger.warn('未检测到生成信号，尝试重新提交提示词');
        const retryClicked = await submitGenerate(page, selectors, logger, generateButtonWaitMs);
        if (retryClicked) {
          const retrySignalOk = await waitForGenerationSignal(page, selectors, signalTimeout, logger);
          if (!retrySignalOk) {
            throw new Error('生成未启动，请检查提示词输入与按钮状态');
          }
        } else {
          throw new Error('生成未启动，请检查提示词输入与按钮状态');
        }
      }

      const popupPage = await popupPromise;
      if (popupPage) {
        try {
          await popupPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
        } catch (_err) {
          // ignore
        }
        if (isCanvasPage(popupPage)) {
          canvasPage = popupPage;
          claimCanvasPage(canvasPage);
        }
      }

      if (!canvasPage) {
        let canvasRetryCount = 0;
        while (!canvasPage) {
          try {
            await page.waitForURL(/lovart\.ai\/canvas/i, { timeout: 5000 });
          } catch (_err) {
            // ignore
          }
          if (isCanvasPage(page)) {
            canvasPage = page;
            claimCanvasPage(canvasPage);
            break;
          }
          canvasPage = await waitForCanvasPage(context, page, canvasWaitTimeout, logger, canvasIgnoreProjectIds);
          if (canvasPage) break;
          if (canvasRetryCount >= canvasRetryLimit) break;
          canvasRetryCount += 1;
          logger.warn('未进入 canvas，尝试重新提交提示词');
          const resubmitted = await maybeResubmitPrompt(
            page,
            selectors,
            options.prompt,
            options.styleRefPath,
            logger,
            referenceUploadTimeout,
            generateButtonWaitMs,
            true
          );
          if (!resubmitted) break;
          const retrySignalOk = await waitForGenerationSignal(page, selectors, signalTimeout, logger);
          if (!retrySignalOk) {
            logger.warn('重新提交后未检测到生成信号');
            break;
          }
        }
        if (!canvasPage) {
          logger.warn('未进入 canvas，尝试强制创建新画布');
          const baseRoot = String(baseUrl || DEFAULT_BASE_URL).replace(/\/zh\/?$/, '').replace(/\/$/, '');
          const forcedCanvasUrl = `${baseRoot}/canvas?agent=1&newProject=true`;
          try {
            await page.goto(forcedCanvasUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
          } catch (err) {
            logger.warn(`打开新画布失败: ${err.message}`);
          }
          if (isCanvasPage(page)) {
            canvasPage = page;
            claimCanvasPage(canvasPage);
          } else {
            const forced = await waitForCanvasPage(context, page, canvasWaitTimeout, logger, canvasIgnoreProjectIds);
            if (forced) {
              canvasPage = forced;
            }
          }
          if (canvasPage) {
            const resubmitted = await maybeResubmitPrompt(
              canvasPage,
              selectors,
              options.prompt,
              options.styleRefPath,
              logger,
              referenceUploadTimeout,
              generateButtonWaitMs,
              true
            );
            if (resubmitted) {
              const forcedSignalOk = await waitForGenerationSignal(canvasPage, selectors, signalTimeout, logger);
              if (!forcedSignalOk) {
                logger.warn('强制新画布后未检测到生成信号');
              }
            } else {
              logger.warn('强制新画布后提示词提交失败');
            }
          }
        }
        if (!canvasPage) {
          throw new Error('未进入画布页面，生成未开始');
        }
      }
    }
    if (canvasPage && canvasPage !== page) {
      if (!existingCanvasPages.has(canvasPage)) {
        ownedPages.add(canvasPage);
      }
      page = canvasPage;
      page.setDefaultTimeout(30000);
    }
    if (effectiveCloseExistingCanvasPages && context) {
      await cleanupLovartCanvasPages(context, page, logger);
    }
    if (!protectExternalPages || ownedPages.has(originPage)) {
      await closeHomePage(originPage, page, logger);
    }
    if (!skipGeneration && !resumeExistingProject) {
      await maybeResubmitPrompt(
        page,
        selectors,
        options.prompt,
        options.styleRefPath,
        logger,
        referenceUploadTimeout,
        generateButtonWaitMs
      );
    }

    const promptSignature = buildPromptSignature(options.prompt);
    let canvasConfirmed = await canvasHasPromptOrImages(page, selectors, promptSignature, logger);
    if (!canvasConfirmed && context) {
      const candidate = await findCanvasPageWithPrompt(context, page, selectors, promptSignature, logger, canvasIgnoreProjectIds);
      if (candidate) {
        if (!existingCanvasPages.has(candidate)) {
          ownedPages.add(candidate);
        }
        page = candidate;
        page.setDefaultTimeout(30000);
        canvasConfirmed = true;
      }
    }

    if (!canvasConfirmed) {
      if (logger) logger.warn('未检测到提示词/图片，忽略当前 canvas');
      canvasUrl = '';
      projectId = '';
    } else {
      try {
        canvasUrl = page.url();
        if (logger && canvasUrl) {
          logger.info(`Canvas URL: ${canvasUrl}`);
        }
      } catch (_err) {
        // ignore
      }

      projectId = extractProjectIdFromUrl(canvasUrl);
      if (!projectId) {
        const refreshed = await refreshCanvasUrl(page, logger, canvasWaitTimeout, "initial");
        if (refreshed.canvasUrl) canvasUrl = refreshed.canvasUrl;
        if (refreshed.projectId) projectId = refreshed.projectId;
      }
      if (projectId && logger) {
        logger.info(`ProjectId 认领: ${projectId}`);
      }
    }
    if (projectName) {
      projectNameApplied = await setProjectName(page, selectors, projectName, logger);
    }
    if (!skipGeneration) {
      await waitForGenerationStart(page, selectors, generateStartTimeout, logger);
    }
    await notifyGenerationStarted();

    const finalizeAndDownload = async () => {
      const minSuccessCount = resolveMinimumSuccessCount(options.expectedCount);
      const readyTimeout = Math.min(generateTimeout, Math.max(resultWaitTimeout, 120000));
      let readyState = await waitForGenerationReady(
        page,
        selectors,
        options.expectedCount,
        minSuccessCount,
        readyTimeout,
        logger,
        abortSignal
      );

      if (!readyState) {
        await captureDebug(page, outputDir, `step_${stepIndex}_generation_timeout`, logger);
        logger.warn('未检测到完成标记，尝试继续生成后再收集图片');
        const continued = await maybeContinueGeneration(page, selectors, logger, {
          continuePrompt: options.continuePrompt || '继续',
          generateButtonWaitMs
        });
        if (continued) {
          await waitForGenerationSignal(page, selectors, generateStartTimeout, logger);
          readyState = await waitForGenerationReady(
            page,
            selectors,
            options.expectedCount,
            minSuccessCount,
            Math.min(readyTimeout, 90000),
            logger,
            abortSignal
          );
        }
      } else {
        logger.info(`生成完成，检测到: ${readyState.selector}`);
      }
      stepIndex += 1;

      if (projectName && !projectNameApplied) {
        projectNameApplied = await setProjectName(page, selectors, projectName, logger);
      }

      if (!projectId || !/projectId=/.test(canvasUrl || '')) {
        const refreshed = await refreshCanvasUrl(page, logger, 60000, "post-ready");
        if (refreshed.canvasUrl) canvasUrl = refreshed.canvasUrl;
        if (refreshed.projectId) projectId = refreshed.projectId;
      }
      await focusCanvas(page, selectors, logger);
      await pressSelectAll(page);
      await page.waitForTimeout(300);

      let agentImageUrls = [];
      let agentImageCount = 0;
      const processDeadline = processStartedAt + processTimeoutMs;
      const downloadDeadline = downloadStageTimeoutMs > 0
        ? Math.min(processDeadline, Date.now() + downloadStageTimeoutMs)
        : processDeadline;
      const ensureWithinDownloadDeadline = () => {
        if (downloadDeadline && Date.now() > downloadDeadline) {
          throw new Error('download_timeout');
        }
      };
      const fullWaitMs = (options.expectedCount && options.expectedCount >= 10)
        ? fullWaitDefaultMs
        : processTimeoutMs;
      const fullDeadline = processStartedAt + fullWaitMs;

      const waitForCountWithRetry = async (targetCount, deadline) => {
        let lastResult = { ok: false, count: 0, urls: [] };
        let zeroSince = null;
        let lastContinueAttemptAt = 0;
        const continueCooldownMs = 20000;
        while (Date.now() < deadline) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          const sliceMs = Math.min(Math.max(5000, zeroImagePollSliceMs), remainingMs);
          if (await hasGenerationErrorIndicator(page, selectors)) {
            throw new Error('generation_error');
          }
          const result = await waitForAgentImagesCount(page, targetCount, sliceMs, logger, abortSignal);
          lastResult = result;
          if (result.ok) return result;

          const count = Number.isFinite(result.count) ? result.count : (result.urls || []).length;
          if (count > 0) {
            zeroSince = null;
            const now = Date.now();
            if (count < targetCount && (now - lastContinueAttemptAt) > continueCooldownMs) {
              const continued = await maybeContinueGeneration(page, selectors, logger, {
                continuePrompt: options.continuePrompt || '继续',
                generateButtonWaitMs
              });
              if (continued) {
                lastContinueAttemptAt = now;
                await waitForGenerationSignal(page, selectors, generateStartTimeout, logger);
              }
            }
            continue;
          }

          if (!zeroSince) zeroSince = Date.now();
          if (zeroImageAbortMs && (Date.now() - zeroSince) >= zeroImageAbortMs) {
            throw new Error('generation_stuck');
          }
          if ((Date.now() - zeroSince) >= zeroImageRetryWindowMs
            && zeroImageRetryCount < maxZeroImageRetries
            && Date.now() < deadline) {
            zeroImageRetryCount += 1;
            zeroSince = null;
            logger.warn('生成图片数量为 0，尝试重新提交提示词');
            resetResults();
            const resubmitted = await maybeResubmitPrompt(
              page,
              selectors,
              options.prompt,
              options.styleRefPath,
              logger,
              referenceUploadTimeout,
              generateButtonWaitMs,
              true
            );
            if (!resubmitted) {
              return result;
            }
            await waitForGenerationStart(page, selectors, generateStartTimeout, logger);
          }
        }
        return lastResult;
      };

      if (logger && options.expectedCount) {
        logger.info(`期望图片数量: ${options.expectedCount}，最小完成: ${minSuccessCount}`);
      }

      if (options.expectedCount) {
        if (options.expectedCount >= 10) {
          const fullResult = await waitForCountWithRetry(options.expectedCount, fullDeadline);
          agentImageUrls = fullResult.urls || [];
          agentImageCount = fullResult.count || agentImageUrls.length;
          if (agentImageCount < minSuccessCount) {
            const minResult = await waitForCountWithRetry(minSuccessCount, processDeadline);
            agentImageUrls = minResult.urls || [];
            agentImageCount = minResult.count || agentImageUrls.length;
          }
        } else {
          const fullResult = await waitForCountWithRetry(options.expectedCount, processDeadline);
          agentImageUrls = fullResult.urls || [];
          agentImageCount = fullResult.count || agentImageUrls.length;
        }
        if (!agentImageUrls.length && readyState && Array.isArray(readyState.urls) && readyState.urls.length) {
          agentImageUrls = readyState.urls;
          agentImageCount = readyState.urls.length;
        }
      } else if (readyState && Array.isArray(readyState.urls) && readyState.urls.length) {
        agentImageUrls = readyState.urls;
        agentImageCount = readyState.urls.length;
      } else {
        agentImageUrls = await collectAgentImageUrls(page);
        agentImageCount = agentImageUrls.length;
      }

      if (agentImageCount === 0) {
        throw new Error('生成图片为 0，重试仍无结果');
      }

      if (options.expectedCount && agentImageCount < minSuccessCount) {
        throw new Error(`生成图片不足 (${agentImageCount}/${minSuccessCount})`);
      }

      const targetDownloadCount = (() => {
        const expectedTotal = Number.isFinite(options.expectedCount)
          ? Math.max(0, Math.floor(options.expectedCount))
          : 0;
        if (expectedTotal > 0 && expectedTotal < 10) {
          return expectedTotal;
        }
        if (expectedTotal > 0) {
          if (agentImageCount > 0 && agentImageCount < expectedTotal) {
            return agentImageCount;
          }
          return expectedTotal;
        }
        return agentImageCount;
      })();

      if (logger && targetDownloadCount) {
        logger.info(`下载目标数量: ${targetDownloadCount}`);
      }

      const ensureWithinProcessDeadline = () => {
        if (Date.now() > processDeadline) {
          throw new Error('处理超时');
        }
      };

      ensureWithinProcessDeadline();
      await ensureFitToScreen(page, selectors, logger);
      await ensureCanvasSelection(page, selectors, logger);

      let downloaded = false;
      const isDownloadComplete = () => {
        const successCount = results.filter(entry => entry.ok).length;
        if (targetDownloadCount) return successCount >= targetDownloadCount;
        if (options.expectedCount) return successCount >= minSuccessCount;
        return successCount > 0;
      };

      const resolveDownloadTargetForUrls = urls => {
        const count = Array.isArray(urls) ? urls.length : 0;
        if (!count) return 0;
        if (targetDownloadCount) return Math.min(targetDownloadCount, count);
        if (options.expectedCount) return Math.min(Math.max(0, Math.floor(options.expectedCount)), count);
        return count;
      };

      const multiImage = options.expectedCount && options.expectedCount > 1;
      const tryDownloadAllFirst = requireDownloadAll || multiImage;
      const attemptToolbarDownload = async () => {
        ensureWithinProcessDeadline();
        ensureWithinDownloadDeadline();
        await scrollPageTop(page);
        await ensureFitToScreen(page, selectors, logger);
        await ensureCanvasSelection(page, selectors, logger);
        const toolbarReady = await hasSelectionToolbar(page);
        if (!toolbarReady) {
          if (logger) logger.warn('未检测到选择工具条，跳过工具栏下载');
          return false;
        }
        await applyDownloadBehavior(context, page, downloadDir, logger);
        await logToolbarButtons(page, logger);
        const candidates = await collectToolbarDownloadCandidates(page, selectors, logger);
        if (!candidates.length) return false;
        logger.info(`尝试工具栏下载...候选 ${candidates.length} 个`);
        for (let idx = 0; idx < candidates.length; idx += 1) {
          let handle = candidates[idx];
          logger.info(`工具栏下载候选 ${idx + 1}/${candidates.length}`);
          let result = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await dismissDownloadToast(page, selectors, logger);
              result = await downloadFromHandle(
                page,
                handle,
                path.join(outputDir, 'lovart_all.png'),
                downloadTimeout,
                logger,
                downloadDir,
                selectors
              );
              break;
            } catch (err) {
              if (err && err.code === 'HANDLE_DETACHED') {
                handle = null;
                break;
              }
              logger.warn(`工具栏下载失败: ${err.message}`);
              break;
            }
          }

          if (result && result.zipPath) {
            const zipResults = await handleZipDownload(
              result.zipPath,
              outputDir,
              options.expectedCount,
              logger
            ).catch(err => {
              logger.warn(`解压失败，改用直链下载: ${err.message}`);
              return null;
            });
            if (zipResults) {
              zipResults.forEach((entry, jdx) => {
                results[jdx] = entry;
              });
              return isDownloadComplete();
            }
          } else if (result && result.filePath) {
            results[0] = {
              ok: true,
              filePath: result.filePath,
              downloadedAt: new Date().toISOString()
            };
            return isDownloadComplete();
          }
        }
        return false;
      };
      const attemptDownloadAll = async () => {
        ensureWithinProcessDeadline();
        ensureWithinDownloadDeadline();
        await scrollPageTop(page);
        await ensureFitToScreen(page, selectors, logger);
        await ensureCanvasSelection(page, selectors, logger);
        const toolbarReady = await hasSelectionToolbar(page);
        if (!toolbarReady) {
          if (logger) logger.warn('未检测到选择工具条，跳过下载全部');
          return false;
        }
        await applyDownloadBehavior(context, page, downloadDir, logger);
        if (requireDownloadAll) {
          const downloadAllReady = await waitForDownloadAllAfterSelection(page, selectors, resultWaitTimeout, logger, abortSignal);
          if (!downloadAllReady) {
            throw new Error('等待下载全部按钮超时，请确认下载入口是否可见');
          }
          if (logger) {
            logger.info(`下载全部按钮已出现: ${downloadAllReady}`);
          }
        }
        let downloadAllMatch = null;
        if (selectors.downloadAllButton) {
          downloadAllMatch = await findFirstHandle(page, selectors.downloadAllButton);
        }
        if (!downloadAllMatch) {
          downloadAllMatch = await findDownloadAllFallback(page, logger, { allowFallback: true });
        }
        if (!downloadAllMatch) return false;
        logger.info('尝试下载全部结果...');
        let result = null;
        try {
          // 清理可能的通知层
          await dismissDownloadToast(page, selectors, logger);
          result = await downloadFromHandle(
            page,
            downloadAllMatch.handle,
            path.join(outputDir, 'lovart_all.png'),
            downloadTimeout,
            logger,
            downloadDir,
            selectors
          );
        } catch (err) {
          logger.warn(`下载全部失败，转为逐张/直链: ${err.message}`);
        }

        if (result && result.zipPath) {
          const zipResults = await handleZipDownload(
            result.zipPath,
            outputDir,
            options.expectedCount,
            logger
          ).catch(err => {
            logger.warn(`解压失败，改用直链下载: ${err.message}`);
            return null;
          });
          if (zipResults) {
            zipResults.forEach((entry, idx) => {
              results[idx] = entry;
            });
            return isDownloadComplete();
          }
        } else if (result && result.filePath) {
          results[0] = {
            ok: true,
            filePath: result.filePath,
            downloadedAt: new Date().toISOString()
          };
          return isDownloadComplete();
        }
        return false;
      };

      if (!downloaded && preferDirectDownload) {
        ensureWithinProcessDeadline();
        ensureWithinDownloadDeadline();
        const urls = agentImageUrls;
        if (urls.length) {
          if (logger) {
            logger.info(`直链优先启用，检测到 ${urls.length} 个生成图片链接`);
          }
          const expectedCount = resolveDownloadTargetForUrls(urls);
          const directDeadline = directDownloadStageMs > 0
            ? Math.min(downloadDeadline, Date.now() + directDownloadStageMs)
            : downloadDeadline;
          const directResults = await downloadImagesWithConcurrency({
            page,
            urls,
            outputDir,
            expectedCount,
            logger,
            concurrency: cappedDirectDownloadConcurrency,
            minSuccessCount,
            timeoutMs: directDownloadTimeoutMs,
            downloadUntilExpected,
            deadlineMs: directDeadline,
            abortSignal
          });
          directResults.forEach((entry, idx) => {
            results[idx] = entry;
          });
          downloaded = isDownloadComplete();
          if (!downloaded && logger) {
            logger.warn('直链下载未完成，尝试下载全部或单张下载');
          }
        }
      }

      if (!downloaded) {
        downloaded = await attemptToolbarDownload();
      }

      if (tryDownloadAllFirst && !downloaded) {
        downloaded = await attemptDownloadAll();
      }

      if (!downloaded && !tryDownloadAllFirst) {
        ensureWithinDownloadDeadline();
        const scaled = await clickZoomOut(page, selectors, logger);
        if (scaled) {
          await page.waitForTimeout(300);
        }
        downloaded = await attemptDownloadAll();
      }

      if (!downloaded && selectors.downloadButtons) {
        ensureWithinDownloadDeadline();
        const buttonTargetCount = targetDownloadCount || (options.expectedCount || 0);
        const toolbarReady = await hasSelectionToolbar(page);
        let downloadButtons = [];
        if (!toolbarReady) {
          logger.warn('未检测到选择工具条，跳过逐张下载按钮');
        } else {
          downloadButtons = await collectDownloadButtons(page, selectors.downloadButtons, buttonTargetCount);
          if (!downloadButtons.length) {
            await scrollResultPanels(page, logger);
            await page.waitForTimeout(500);
            downloadButtons = await collectDownloadButtons(page, selectors.downloadButtons, buttonTargetCount);
          }
        }
        if (!downloadButtons.length) {
          logger.warn('未找到下载按钮，尝试从页面提取图片链接');
        } else {
          for (let i = 0; i < buttonTargetCount; i++) {
            ensureWithinProcessDeadline();
            if (!downloadButtons[i]) {
              results[i] = { ok: false, error: '缺少下载按钮' };
              continue;
            }
            await applyDownloadBehavior(context, page, downloadDir, logger);
            const targetPath = path.join(outputDir, `${padIndex(i + 1)}.png`);
            let attempt = 0;
            let lastError = null;
            let buttonHandle = downloadButtons[i];
            while (attempt < 2) {
              try {
                // 每次下载前清理可能的通知层
                await dismissDownloadToast(page, selectors, logger);
                const result = await downloadFromHandle(
                  page,
                  buttonHandle,
                  targetPath,
                  downloadTimeout,
                  logger,
                  downloadDir,
                  selectors
                );
                if (result.zipPath) {
                  logger.warn('下载结果为 zip，改用解压流程');
                  const zipResults = await handleZipDownload(
                    result.zipPath,
                    outputDir,
                    options.expectedCount,
                    logger
                  ).catch(err => {
                    logger.warn(`解压失败，改用直链下载: ${err.message}`);
                    return null;
                  });
                  if (zipResults) {
                    zipResults.forEach((entry, idx) => {
                      results[idx] = entry;
                    });
                    downloaded = isDownloadComplete();
                  }
                  break;
                }
                results[i] = {
                  ok: true,
                  filePath: result.filePath,
                  downloadedAt: new Date().toISOString()
                };
                if (isDownloadComplete()) break;
                lastError = null;
                break;
              } catch (err) {
                lastError = err;
                if (attempt === 0 && isElementDetachedError(err)) {
                  logger.warn(`下载按钮句柄失效，重新定位: ${padIndex(i + 1)}`);
                  downloadButtons = await collectDownloadButtons(page, selectors.downloadButtons, buttonTargetCount);
                  buttonHandle = downloadButtons[i];
                  if (!buttonHandle) {
                    lastError = new Error('缺少下载按钮');
                    break;
                  }
                  attempt += 1;
                  continue;
                }
                break;
              }
            }
            if (lastError) {
              results[i] = { ok: false, error: lastError.message };
              logger.warn(`下载失败: ${padIndex(i + 1)} (${lastError.message})`);
            }
          }
          downloaded = isDownloadComplete();
        }
      }

      if (!downloaded) {
        ensureWithinProcessDeadline();
        ensureWithinDownloadDeadline();
        const urls = await collectAgentImageUrls(page);
        if (!urls.length) {
          throw new Error('未检测到生成图片链接，请检查页面状态');
        }
        if (logger) {
          logger.info(`图片链接样例: ${urls.slice(0, 3).join(' | ')}`);
        }
        logger.info(`检测到 ${urls.length} 个生成图片链接，开始下载`);
        const expectedCount = resolveDownloadTargetForUrls(urls);
        const directResults = await downloadImagesWithConcurrency({
          page,
          urls,
          outputDir,
          expectedCount,
          logger,
          concurrency: cappedDirectDownloadConcurrency,
          minSuccessCount,
          timeoutMs: directDownloadTimeoutMs,
          downloadUntilExpected,
          deadlineMs: downloadDeadline,
          abortSignal
        });
        directResults.forEach((entry, idx) => {
          results[idx] = entry;
        });
        downloaded = isDownloadComplete();
      }

      const expectedTotal = Number.isFinite(options.expectedCount)
        ? Math.max(0, Math.floor(options.expectedCount))
        : results.length;
      const successCount = results.filter(entry => entry.ok).length;
      const ok = expectedTotal > 0 ? successCount >= minSuccessCount : successCount > 0;
      return { ok, results, successCount, expectedCount: expectedTotal, canvasUrl, projectId, projectName, projectNameApplied };
    };

    let finalResult = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        finalResult = await finalizeAndDownload();
        break;
      } catch (err) {
        if (isPageClosedError(err) && attempt === 0) {
          logger.warn('页面被关闭，尝试恢复并继续下载');
          const recoveryUrl = canvasUrl || existingCanvasUrl;
          if (!recoveryUrl) {
            throw new Error('页面关闭且缺少 canvas URL，无法恢复');
          }
          page = await reopenCanvasPage(context, recoveryUrl, selectorsConfig.create_url, navigationTimeout, logger);
          page.setDefaultTimeout(30000);
          continue;
        }
        throw err;
      }
    }

    return finalResult;
  } catch (err) {
    logger.error(`Lovart 执行失败: ${err.message}`);
    if (page) {
      await captureDebug(page, outputDir, `step_${stepIndex}_error`, logger);
    }
    return { ok: false, results, error: err.message, canvasUrl, projectId, projectName, projectNameApplied };
  } finally {
    if (closePagesOnDone) {
      const pagesToClose = new Set(ownedPages);
      if (!protectExternalPages) {
        if (page) pagesToClose.add(page);
        if (originPage) pagesToClose.add(originPage);
      } else {
        if (page && ownedPages.has(page)) pagesToClose.add(page);
        if (originPage && ownedPages.has(originPage)) pagesToClose.add(originPage);
      }
      for (const ownedPage of pagesToClose) {
        if (!ownedPage || ownedPage.isClosed()) continue;
        const shouldClose = await isLovartPage(ownedPage);
        if (!shouldClose) continue;
        await ownedPage.close().catch(() => {});
      }
    }

    const pagesToRelease = new Set(ownedPages);
    if (page) pagesToRelease.add(page);
    if (originPage) pagesToRelease.add(originPage);
    pagesToRelease.forEach(p => unclaimCanvasPage(p));

    if (useCdp) {
      if (browser && typeof browser.disconnect === 'function') {
        await browser.disconnect();
      }
    } else if (shouldCloseBrowser) {
      if (usePersistent && context) {
        await context.close().catch(() => {});
        if (context === cachedPersistentContext) {
          cachedPersistentContext = null;
          cachedPersistentBrowser = null;
          cachedPersistentMeta = null;
        }
      } else if (browser) {
        await browser.close().catch(() => {});
      }
    } else if (!shouldCloseBrowser) {
      logger.info('浏览器保持打开状态');
    }
  }
}

module.exports = {
  runLovartBatch
};
