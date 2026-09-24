// 飞书自建应用推送：读取 data/hot-news.json → 组装 interactive 卡片 → POST 到 Feishu API
// 零依赖，Node.js 内置 https
const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const CHAT_ID = process.env.FEISHU_CHAT_ID;

// 顺序即卡片展示顺序，抖音已删（cookie 机制复杂）
const PLATFORM_ICONS = {
  weibo: '🔥 微博热搜',
  zhihu: '📚 知乎热榜',
  baidu: '🔍 百度热搜',
  '36kr': '💡 36氪',
  juejin: '⛏️ 掘金',
  hackernews: '👾 HackerNews',
  github: '⭐ GitHub Trending',
};

// 数字格式化 + 热度分级 emoji
function fmtHot(v) {
  if (!v) return '';
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) || 0 : v;
  if (!n) return '';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}
function hotEmoji(v) {
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) || 0 : (v || 0);
  if (n >= 5000000) return '🔥🔥🔥';
  if (n >= 1000000) return '🔥🔥';
  if (n >= 100000) return '🔥';
  return '';
}
const MEDALS = ['🥇', '🥈', '🥉', '④', '⑤'];

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

function buildCard(data) {
  const hotNews = data.dailyhot || data;
  const github = data.github || [];

  const elements = [];
  let total = 0;

  // 构造一个源的行列表（column_set 三列布局）
  function buildSourceSection(label, key, items, titleExtract = null) {
    if (key === 'github') return;

    const list = items.slice(0, 5).filter((it) => it.title && it.title !== '暂无数据');
    if (list.length === 0) return;

    total += list.length;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${label}**` },
    });

    list.forEach((it, i) => {
      const title = titleExtract ? titleExtract(it) : (it.title || '').replace(/\n/g, '').substring(0, 45);
      const url = it.url || '#';
      const hot = hotEmoji(it.hot);
      elements.push({
        tag: 'column_set',
        horizontal_spacing: 'small',
        margin: '1px 0px',
        columns: [
          {
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: MEDALS[i] || `${i + 1}.` } }],
          },
          {
            tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: `[${title}](${url})` } }],
          },
          {
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: hot } }],
          },
        ],
      });
    });
    elements.push({ tag: 'hr' });
  }

  // 各热榜源
  for (const [key, label] of Object.entries(PLATFORM_ICONS)) {
    if (key === 'github') continue;
    buildSourceSection(label, key, hotNews[key] || []);
  }

  // GitHub Trending
  const ghItems = github.slice(0, 5);
  if (ghItems.length > 0) {
    total += ghItems.length;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**⭐ GitHub Trending**' } });
    ghItems.forEach((it, i) => {
      const title = (it.title || '').replace(/\n/g, '').substring(0, 55);
      const url = it.url || '#';
      // GitHub 的 star 数直接显示，不走热度 emoji
      const stars = (it.hot || '').replace('⭐ ', '');
      elements.push({
        tag: 'column_set',
        horizontal_spacing: 'small',
        margin: '1px 0px',
        columns: [
          {
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: MEDALS[i] || `${i + 1}.` } }],
          },
          {
            tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: `[${title}](${url})` } }],
          },
          {
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: stars ? `⭐${stars}` : '' } }],
          },
        ],
      });
    });
  }

  // 删掉最后一个 hr（如果存在）+ 加底部
  while (elements[elements.length - 1]?.tag === 'hr') elements.pop();
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `🤖 Auto | Cloudflare Worker + GitHub Actions` }],
  });

  // 头部信息
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  elements.unshift({ tag: 'hr' });
  elements.unshift({
    tag: 'div',
    text: { tag: 'lark_md', content: `<font color='grey'>共 ${total} 条 · 每 30 分钟自动更新</font>` },
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📰 每日热榜 · ${now}` },
      template: 'turquoise',
    },
    elements,
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
