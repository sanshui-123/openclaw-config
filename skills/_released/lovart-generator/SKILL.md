---
name: lovart-generator
version: 2.0.0
description: 自动化 Lovart 生图工具（CDP 模式，截图保存）
triggers:
  - keyword: "lovart 生图"
  - keyword: "生成图片"
  - keyword: "lovart task"
---

# Lovart 生图 Skill v2

## 功能
1. 从飞书多维表领取任务（status=new, rewritten_content>=30）
2. 使用 CDP 连接 Chrome 访问 Lovart 生成图片
3. **截图方式保存图片**（绕过下载按钮，避免 CDN 检测）
4. **页面空白检测 + 自动刷新**
5. 完成后回写到多维表（标准 JSON 格式）
6. 保持登录态（不关闭页面）

## 使用方式

### 1. 启动 Chrome（CDP 模式）
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=19222 \
  --user-data-dir=/Users/xincheng/openclaw-os/chrome-data \
  "https://www.lovart.ai/zh/home" &
```

### 2. 确保 Lovart 已登录

### 3. 启动 Worker
```bash
cd /Users/xincheng/openclaw-os
node scripts/lovart_worker_v2.js
```

### 4. 投递任务（通过多维表）
- 多维表: https://r94w8ejtw4.feishu.cn/base/ISJvboGeeaRkbwsQP5UcaGtrnDc
- 必填: task_id, rewritten_content (>=30字符)
- status 设为 new 或留空

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| CDP_URL | http://127.0.0.1:19222 | Chrome CDP 地址 |
| OUTPUT_DIR | /Users/xincheng/openclaw-os/results | 输出目录 |

## 输出格式

```json
{
  "task_id": "xxx",
  "status": "success",
  "duration_ms": 14674,
  "image_size_bytes": 82408,
  "image_mime": "image/png",
  "image_urls": ["file:///path/to/result.png"],
  "attachments": [],
  "error": ""
}
```

## 注意事项
1. **不要关闭 Chrome**（会丢失登录态）
2. **不要清理 chrome-data**（会丢失登录态）
3. Worker 会自动处理新任务

## 文件结构
- `scripts/lovart_worker_v2.js` - Worker 主程序
- `config/lovart.selectors.json` - 选择器配置
- `utils/lovart_runner.js` - 运行器（来自 golf-scraper）

---
*Updated by 小孙 @ 2026-02-23*
