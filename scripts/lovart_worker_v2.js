#!/usr/bin/env node
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');

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
  
  for (const item of items) {
    const s = item.fields.status;
    const tid = item.fields.task_id;
    const content = item.fields.rewritten_content || '';
    const claimed = item.fields.claimed_by;
    
    const isNew = s === 'new' || s === null || s === undefined || s === '';
    const hasTaskId = tid && tid.trim() !== '';
    const hasContent = content.length >= 30;
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
  console.log(`[TASK] 提示词: ${prompt.substring(0, 50)}...`);
  
  const taskDir = `${CONFIG.OUTPUT_DIR}/${taskId}`;
  const path = require('path');
  
  try {
    const browser = await chromium.connectOverCDP(CONFIG.CDP_URL);
    const contexts = browser.contexts();
    const page = contexts[0].pages().find(p => p.url().includes('lovart')) || (await contexts[0].newPage());
    
    console.log('[BROWSER] 已连接');
    
    // 导航到 Lovart
    await page.goto('https://www.lovart.ai/zh/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    // 检测页面是否空白，如果空白则刷新
    console.log('[CHECK] 检测页面状态...');
    let isBlank = await page.evaluate(() => {
      const input = document.querySelector('div[role="textbox"]') || document.querySelector('textarea');
      const content = document.body.innerText;
      return !input && content.length < 100;
    });
    
    if (isBlank) {
      console.log('[REFRESH] 页面空白，正在刷新...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(5000);
      
      // 再次检测
      isBlank = await page.evaluate(() => {
        const input = document.querySelector('div[role="textbox"]') || document.querySelector('textarea');
        return !input;
      });
      
      if (isBlank) {
        throw new Error('页面刷新后仍然空白');
      }
    }
    
    console.log('[PAGE] 页面正常');
    
    // 填充提示词
    console.log('[INPUT] 填充提示词...');
    const inputBox = await page.$('div[role="textbox"]');
    if (inputBox) {
      await inputBox.click({ force: true });
      await page.waitForTimeout(500);
      await inputBox.fill('');
      await page.waitForTimeout(200);
      await inputBox.fill(prompt);
      await page.waitForTimeout(2000);
    }
    
    // 提交
    console.log('[SUBMIT] 提交生成...');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    
    // 等待图片生成
    console.log('[WAIT] 等待图片生成...');
    let imageUrl = null;
    for (let i = 0; i < 120; i++) {
      imageUrl = await page.evaluate(() => {
        const images = document.querySelectorAll('img[src*="artifacts/"]');
        if (images.length > 0) {
          return images[0].src;
        }
        return null;
      });
      
      if (imageUrl) break;
      await page.waitForTimeout(1000);
    }
    
    if (!imageUrl) {
      throw new Error('生成超时，未找到图片 URL');
    }
    
    console.log('[GENERATED] 图片URL:', imageUrl);
    
    // 截图方式保存图片（避免 fetch 被阻止）
    console.log('[DOWNLOAD] 开始截图保存...');
    
    // 找到图片元素并截图
    const imgElement = await page.$('img[src*="artifacts/"]');
    if (!imgElement) {
      throw new Error('未找到图片元素');
    }
    
    const outputPath = `${taskDir}/result.png`;
    fs.mkdirSync(taskDir, { recursive: true });
    
    await imgElement.screenshot({ path: outputPath });
    
    const stats = fs.statSync(outputPath);
    let imageMime = 'image/png';
    
    const resultJson = {
      task_id: taskId,
      status: 'success',
      duration_ms: Date.now() - startTime,
      image_size_bytes: stats.size,
      image_mime: imageMime,
      image_urls: [`file://${outputPath}`],
      attachments: [],
      error: ''
    };
    
    await updateRecord(task.record_id, {
      status: 'done',
      image_urls: `file://${outputPath}`,
      image_mime: imageMime,
      image_size_bytes: stats.size,
      duration_ms: resultJson.duration_ms,
      finished_at: Date.now()
    });
    
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify(resultJson, null, 2));
    
    console.log(`[TASK] 完成！耗时: ${resultJson.duration_ms}ms, 大小: ${stats.size} bytes`);
    console.log('[RESULT]', JSON.stringify(resultJson, null, 2));
    
    await browser.close();
    
  } catch (e) {
    const duration = Date.now() - startTime;
    
    const resultJson = {
      task_id: taskId,
      status: 'failed',
      duration_ms: duration,
      image_size_bytes: 0,
      image_mime: '',
      image_urls: [],
      attachments: [],
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
    
    console.log(`[TASK] 失败: ${e.message}`);
    console.log('[RESULT]', JSON.stringify(resultJson, null, 2));
    
    try {
      await browser.close();
    } catch (err) {
    }
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Lovart 生图节点 - 浏览器内 fetch 下载模式');
  console.log('='.repeat(50));
  console.log(`CDP: ${CONFIG.CDP_URL}`);
  console.log('='.repeat(50));
  
  fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  
  while (true) {
    try {
      const task = await claimTask();
      if (task) {
        await processTask(task);
      } else {
        process.stdout.write('.');
      }
    } catch (e) {
      console.error(`\n[ERROR] ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

main().catch(e => {
  console.error('崩溃:', e);
  process.exit(1);
});
