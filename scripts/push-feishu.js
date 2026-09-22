// 飞书自建应用推送：读取 data/hot-news.json → 组装 interactive 卡片 → POST 到 Feishu API
// 零依赖，Node.js 内置 https
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const CHAT_ID = process.env.FEISHU_CHAT_ID;

const PLATFORM_ICONS = {
  weibo: '🔥 微博',
  baidu: '🔍 百度',
  zhihu: '💡 知乎',
  douyin: '🎵 抖音',
  space: '🚀 航天',
  github: '⭐ GitHub',
  tech: '💻 Hacker News',
};

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getToken() {
  const r = await request(
    {
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { app_id: APP_ID, app_secret: APP_SECRET }
  );
  const j = JSON.parse(r.data);
  if (j.code !== 0) throw new Error(`Feishu token: ${j.code} ${j.msg}`);
  return j.tenant_access_token;
}

function buildCard(hotNews) {
  const sections = [];
  for (const [key, icon] of Object.entries(PLATFORM_ICONS)) {
    const items = (hotNews[key] || []).slice(0, 5);
    if (items.length === 0) continue;
    const lines = items
      .map((it, i) => {
        const title = it.title.replace(/\n/g, '').substring(0, 40);
        const hot = it.hot || '';
        const url = it.url || '';
        return `${i + 1}. [${title}](${url})  ${hot ? `\`${hot}\`` : ''}`;
      })
      .join('\n');
    sections.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${icon}**\n${lines}` },
    });
  }

  const total = Object.values(hotNews).reduce((s, arr) => s + (arr || []).length, 0);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔥 热点推送 ${now}` },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**共 ${total} 条热榜** | 每 30 分钟自动更新` } },
      { tag: 'hr' },
      ...sections,
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: `🤖 GitHub Actions 自动抓取 | jsDelivr CDN 加速` },
        ],
      },
    ],
  };
}

async function sendCard(token, chatId, card) {
  const r = await request(
    {
      hostname: 'open.feishu.cn',
      path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    },
    {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }
  );
  const j = JSON.parse(r.data);
  if (j.code !== 0) throw new Error(`Feishu send: ${j.code} ${j.msg}`);
  return j;
}

(async () => {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log('[feishu] SKIP: missing FEISHU_APP_ID / SECRET / CHAT_ID');
    process.exit(0);
  }

  const jsonPath = path.join(__dirname, '..', 'data', 'hot-news.min.json');
  if (!fs.existsSync(jsonPath)) {
    console.log('[feishu] SKIP: hot-news.min.json not found');
    process.exit(0);
  }

  const token = await getToken();
  const card = buildCard(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')));
  await sendCard(token, CHAT_ID, card);
  console.log('[feishu] OK: card sent');
})().catch((e) => {
  console.error('[feishu] FAIL:', e.message);
  process.exit(1);
});
