#!/usr/bin/env node
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  FEISHU_APP_ID: 'cli_a903261bc3395bce',
  FEISHU_APP_SECRET: 'gzfMzxEBURI17v7Zwhta2eEzGabVM7qH',
  BITABLE_APP_TOKEN: 'ISJvboGeeaRkbwsQP5UcaGtrnDc',
  BITABLE_TABLE_ID: 'tblcEGBpEhIIprIc',
  WORKER_NAME: 'xinchengdeMacBook-Air.local',
  OUTPUT_DIR: '/Users/xincheng/openclaw-os/results',
  CDP_URL: 'http://127.0.0.1:19222',
};

let accessToken = null;
let tokenExpireAt = 0;

async function getAccessToken() {
  if (accessToken && tokenExpireAt > Date.now()) return accessToken;
  
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: CONFIG.FEISHU_APP_ID,
    app_secret: CONFIG.FEISHU_APP_SECRET
  });
  
  if (res.data.code !== 0) throw new Error(`获取token失败: ${res.data.msg}`);
  
  accessToken = res.data.tenant_access_token;
  tokenExpireAt = Date.now() + (res.data.expire - 60) * 1000;
  return accessToken;
}

async function updateRecord(recordId, fields) {
  const token = await getAccessToken();
  const res = await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_APP_TOKEN}/tables/${CONFIG.BITABLE_TABLE_ID}/records/${recordId}`,
    { fields },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.data.code !== 0) throw new Error(`更新失败: ${res.data.msg}`);
  return res.data.data.record;
}

async function getRecords() {
  const token = await getAccessToken();
  const res = await axios.get(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_APP_TOKEN}/tables/${CONFIG.BITABLE_TABLE_ID}/records?page_size=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.data.code !== 0) throw new Error(`读取失败: ${res.data.msg}`);
  return res.data.data.items || [];
}

async function claimTask() {
  const items = await getRecords();
  const now = Date.now();
  
  console.log(`[CLAIM] 队列总数: ${items.length}`);
  
  for (const item of items) {
    const s = item.fields.status;
    const tid = item.fields.task_id;
    const content = item.fields.rewritten_content || '';
    const claimed = item.fields.claimed_by;
    
    const isNew = s === 'new' || s === null || s === undefined || s === '';
    const hasTaskId = tid && tid.trim() !== '';
    const hasContent = content && content.length >= 10;
    const notClaimed = !claimed;
    
    if (isNew && hasTaskId && hasContent && notClaimed) {
      await updateRecord(item.record_id, {
        status: 'processing',
        claimed_by: CONFIG.WORKER_NAME,
        claimed_at: now
      });
      
      console.log(`\n[CLAIM] 领取任务: ${tid}`);
      return item;
    }
  }
  
  return null;
}

async function processTask(task) {
  const startTime = Date.now();
  const taskId = task.fields.task_id;
  const prompt = task.fields.rewritten_content;
  
  console.log(`[TASK] 开始: ${taskId}`);
  console.log(`[TASK] 提示词长度: ${prompt.length} 字符`);
  
  const taskDir = `${CONFIG.OUTPUT_DIR}/${taskId}`;
  let page = null;
  
  try {
    const browser = await chromium.connectOverCDP(CONFIG.CDP_URL);
    const contexts = browser.contexts();
    
    // 优先找到现有的主页，如果没有则创建新页面
    page = contexts[0].pages().find(p => p.url().includes('lovart.ai/zh/home'));
    if (!page) {
      // 如果没有主页，尝试找到任何 lovart 页面
      page = contexts[0].pages().find(p => p.url().includes('lovart'));
    }
    if (!page) {
      // 如果没有 lovart 页面，创建一个新的
      page = await contexts[0].newPage();
    }
    
    console.log('[BROWSER] 已连接');
    
    // 关闭所有非主页的 Lovart 页面（如 canvas 页面）
    console.log('[CLEANUP] 清理多余的页面...');
    const allPages = contexts[0].pages();
    for (const p of allPages) {
      if (p !== page && p.url().includes('lovart')) {
        await p.close();
        console.log('[CLEANUP] 关闭多余的页面:', p.url().substring(0, 50));
      }
    }
    console.log('[CLEANUP] ✅ 清理完成');
    
    // 刷新页面
    console.log('[REFRESH] 刷新页面...');
    await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);
    console.log('[REFRESH] ✅ 完成');
    
    // 填充提示词
    console.log('[INPUT] 填充提示词...');
    const inputBox = await page.$('div[role="textbox"]');
    if (!inputBox) {
      throw new Error('未找到输入框');
    }
    
    await inputBox.click({ force: true });
    await page.waitForTimeout(1000);
    await inputBox.fill('');
    await page.waitForTimeout(500);
    
    // 截取提示词（避免过长）
    const truncatedPrompt = prompt.substring(0, 500);
    await inputBox.fill(truncatedPrompt);
    await page.waitForTimeout(3000);
    console.log('[INPUT] ✅ 填充完成');
    
    // 点击生成按钮
    console.log('[GENERATE] 点击生成按钮...');
    const button = await page.$('button svg');
    if (!button) {
      throw new Error('未找到生成按钮');
    }
    
    await button.click({ force: true });
    console.log('[GENERATE] ✅ 已点击');
    
    // 等待 canvas 页面出现
    console.log('[CANVAS] 等待 canvas 页面...');
    let canvasPage = null;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000);
      
      const pages = contexts[0].pages();
      canvasPage = pages.find(p => p.url().includes('canvas'));
      
      if (canvasPage) {
        console.log(`[CANVAS] ✅ [${i * 5}秒] 检测到 canvas 页面`);
        console.log(`[CANVAS] URL: ${canvasPage.url()}`);
        break;
      }
      
      if (i % 6 === 0) {
        console.log(`[CANVAS] [${i * 5}秒] 等待中...`);
      }
    }
    
    if (!canvasPage) {
      throw new Error('未检测到 canvas 页面');
    }
    
    // 在 canvas 页面提取图片
    console.log('[EXTRACT] 提取图片...');
    await canvasPage.waitForTimeout(5000);
    
    const images = await canvasPage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const canvasImages = imgs.filter(img => img.src && img.src.includes('artifact')).map(img => img.src);
      
      // 去重
      const uniqueImages = [...new Set(canvasImages)];
      return uniqueImages;
    });
    
    if (images.length === 0) {
      throw new Error('未找到生成的图片');
    }
    
    console.log(`[EXTRACT] ✅ 找到 ${images.length} 张图片`);
    
    // 使用第一张图片
    const imageUrl = images[0];
    console.log(`[IMAGE] 图片URL: ${imageUrl}`);
    
    // 截图保存
    console.log('[SCREENSHOT] 保存截图...');
    fs.mkdirSync(taskDir, { recursive: true });
    const screenshotPath = path.join(taskDir, 'result.png');
    await canvasPage.screenshot({ path: screenshotPath, fullPage: true });
    console.log('[SCREENSHOT] ✅ 完成');
    
    // 更新飞书记录
    const duration = Date.now() - startTime;
    console.log('[UPDATE] 更新飞书记录...');
    await updateRecord(task.record_id, {
      status: 'done',
      image_urls: imageUrl,
      image_mime: 'image/png',
      duration_ms: duration,
      finished_at: Date.now()
    });
    console.log('[UPDATE] ✅ 完成');
    
    // 保存本地结果
    const resultJson = {
      task_id: taskId,
      status: 'success',
      duration_ms: duration,
      image_urls: [imageUrl],
      all_images: images,
      error: ''
    };
    
    fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify(resultJson, null, 2));
    
    console.log(`[TASK] ✅ 完成！耗时: ${duration}ms`);
    console.log('[RESULT]', JSON.stringify(resultJson, null, 2));
    
    // 关闭 canvas 页面并返回首页
    console.log('[CLEANUP] 关闭 canvas 页面...');
    if (canvasPage && canvasPage !== page) {
      await canvasPage.close();
      console.log('[CLEANUP] ✅ Canvas 页面已关闭');
    }
    
    console.log('[NAV] 返回首页...');
    await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[NAV] ✅ 完成');
    
  } catch (e) {
    const duration = Date.now() - startTime;
    
    const resultJson = {
      task_id: taskId,
      status: 'failed',
      duration_ms: duration,
      image_urls: [],
      error: e.message
    };
    
    await updateRecord(task.record_id, {
      status: 'failed',
      error: e.message,
      duration_ms: duration,
      finished_at: Date.now()
    });
    
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify(resultJson, null, 2));
    
    console.log(`[TASK] ❌ 失败: ${e.message}`);
    
    // 尝试返回首页
    if (page) {
      try {
        await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'networkidle', timeout: 30000 });
        console.log('[NAV] ✅ 已返回首页');
      } catch (navErr) {
        console.log('[NAV] ⚠️  返回失败');
      }
    }
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Lovart Worker V3 - Canvas页面检测模式');
  console.log('='.repeat(50));
  console.log(`CDP: ${CONFIG.CDP_URL}`);
  console.log('='.repeat(50));
  
  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  
  let isProcessing = false;
  
  while (true) {
    if (isProcessing) {
      process.stdout.write('W');
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    
    try {
      const task = await claimTask();
      if (task) {
        isProcessing = true;
        await processTask(task);
        
        console.log('[WAIT] 等待8秒后处理下一个任务...');
        await new Promise(r => setTimeout(r, 8000));
        
        isProcessing = false;
        console.log('[QUEUE] ✅ 可以处理下一个任务');
      } else {
        process.stdout.write('.');
      }
    } catch (e) {
      console.error(`\n[ERROR] ${e.message}`);
      isProcessing = false;
      await new Promise(r => setTimeout(r, 15000));
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

main().catch(e => {
  console.error('崩溃:', e);
  process.exit(1);
});
