'use strict';
/**
 * 演示模式：未配置大模型 API Key 时使用的内置模板引擎。
 * 明确标注为"示例"，避免用户误判真实模型能力。
 */

const SHOT_COUNT = { '15': 6, '30': 10, '60': 16 };

const DEMO_NOTE = '\n\n> 【演示模式示例】当前未配置大模型 API Key，以上内容由内置模板拼装，仅用于体验产品流程，不代表真实模型的生成效果。';

function ctx(form) {
  const name = form.productName?.trim() || '这款好物';
  const cat = form.category?.trim() || '好物';
  const points = (Array.isArray(form.sellingPoints) ? form.sellingPoints : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const audience = form.audience?.trim() || `正在被${cat}问题困扰的人`;
  const price = form.price?.trim() || '点进去看价格，比你想的划算';
  const usage = form.usageScene?.trim() || '日常生活里';
  const duration = SHOT_COUNT[form.duration] ? String(form.duration) : '30';
  const first = points[0] || `${cat}里最容易被忽略的那个细节`;
  return { name, cat, points, audience, price, usage, duration, first };
}

function talkScript(form) {
  const { name, cat, points, audience, usage, price, first, duration } = ctx(form);
  const p = points.length ? points : [`${cat}的核心优势`, '细节做工到位', '用起来省心'];
  const marks = duration === '15'
    ? { hook: '0-2s', pain: '2-6s', sell: '6-11s', trust: '11-13s', cta: '13-15s' }
    : duration === '60'
      ? { hook: '0-3s', pain: '3-12s', sell: '12-42s', trust: '42-52s', cta: '52-60s' }
      : { hook: '0-3s', pain: '3-9s', sell: '9-22s', trust: '22-27s', cta: '27-30s' };

  const bullets = p
    .slice(0, 4)
    .map((s) => `卖点：${s} ｜ 怎么说：${usage}的时候你就知道它和普通${cat}差在哪 —— ${s}，用一次就回不去了。`)
    .join('\n\n');

  return `## 黄金3秒钩子
主选：别再乱买${cat}了，${first}才是关键。（痛点）
备选1：我把它拆开看了三遍，才知道之前全买错了。（悬念）
备选2：用了它以后，我把家里旧的${cat}全扔了。（结果前置）

## 痛点共鸣（${marks.pain}）
你是不是也这样：${usage}，别人三下两下就搞定，
你折腾半天还搞不定，越弄越烦，最后干脆放弃。
不是你的问题，是你手上的工具真的不对。

## 产品亮相 + 核心卖点（${marks.sell}）
就是我手上这个 —— ${name}。它牛在哪？

${bullets}

## 信任背书（${marks.trust}）
我自己实打实用了一段时间，不是拆箱就吹。
细节你们看这个位置，做工是经得起放大看的。
不满意直接退，售后有人管。

## 逼单 CTA（${marks.cta}）
今天这波是真划算：${price}。
喜欢就点左下角小黄车，先加购别犹豫。

## 拍摄提示
1. 机位：竖屏，正面中近景，人物占 1/3、商品特写占 2/3。
2. 前 3 秒怼脸直出，不要片头、不要 logo、不要说"大家好"。
3. 讲痛点时切一个"翻车现场"实拍镜头，真实感最能留人。
4. 讲卖点时给细节特写，语速放慢。
5. 结尾配合手势指向屏幕左下角，字幕同步打出"点击左下角"。${DEMO_NOTE}`;
}

function titleSet(form) {
  const { name, cat, audience, price, first, points } = ctx(form);
  const key = points[0] || first;
  const titles = [
    `买${cat}别乱挑，看这三点就够了（干货型）`,
    `${first}，很多人第一步就选错了（反常识型）`,
    `用了${name}之后，我再也没换回去（结果型）`,
    `家里${cat}还是老样子？试试换个思路（痛点型）`,
    `专门给${audience}准备的一个方案（身份代入型）`,
    `${name}到底值不值？我拆开给你看（悬念型）`,
    `${cat}这东西，图便宜真会踩坑（避坑型）`,
    `${audience}可以放心入的一套组合（人群型）`,
    `${key}这一点，确实挺少见（对比型）`,
    `${price}，这配置有点出乎意料（价格型）`,
  ];
  const tags = {
    broad: ['#好物推荐', '#抖音好物', '#涨知识', '#实用好物', '#生活小妙招'],
    people: audience.split(/[、,，\s]+/).filter(Boolean).slice(0, 4).map((a) => `#${a}`),
    scene: [`#${cat}`, `#${cat}推荐`, `#${cat}怎么选`, `#居家好物`, `#平价好物`],
  };
  if (!tags.people.length) tags.people.push('#精致生活', '#懒人必备', '#居家好物');

  return `## 视频标题
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## 封面大字
・${(key || name).slice(0, 8)}
・别再乱买了
・我拆开看了
・用完回不去了
・图便宜真会坑

## 话题标签
### 泛流量标签
${tags.broad.join(' ')}
### 精准人群标签
${tags.people.join(' ')}
### 品类场景标签
${tags.scene.join(' ')}

## 评论区引导话术
・你现在用的是哪种？评论区晒一下我帮你看看
・想要选款清单的，评论区打「1」
・我先说结论：关键就看这一点，你猜是哪个？
・踩过坑的朋友评论区集合${DEMO_NOTE}`;
}

function storyboard(form) {
  const { name, audience, price, first, duration, usage, cat } = ctx(form);
  const n = SHOT_COUNT[duration] || 10;
  const total = Number(duration);
  const seg = Math.max(1, Math.round((total / n) * 10) / 10);

  const scriptLines = [
    '别急着划走，这条能帮你少踩坑。',
    `是不是每次${usage}都特别烦？`,
    '问题真不在你，在工具上。',
    `这个就是 —— ${name}。`,
    `它牛在：${first}。`,
    '你放大看这个细节，做工经得起看。',
    '我自己用了一段时间，不是拆箱就吹。',
    `${audience}真的可以试试。`,
    `${price}。`,
    '喜欢点左下角小黄车，先加购。',
  ];

  const shots = [];
  for (let i = 0; i < n; i++) {
    const start = (i * seg).toFixed(1).replace(/\.0$/, '');
    const end = (Math.min(total, (i + 1) * seg)).toFixed(1).replace(/\.0$/, '');
    const beat = i === 0 ? '钩子' : i === n - 1 ? '逼单' : i < n * 0.35 ? '痛点' : i < n * 0.8 ? '卖点' : '背书';
    const visual =
      beat === '钩子' ? '怼脸中近景，直视镜头，语速快'
        : beat === '痛点' ? '实拍翻车现场，手持轻微晃动，慢镜'
          : beat === '卖点' ? '商品微距特写 + 使用演示，固定机位'
            : beat === '背书' ? '自然光下细节特写，缓慢横移'
              : '商品摆拍 + 手指指向左下角，固定机位';
    shots.push(
      `| ${i + 1} | ${start}-${end}s | ${visual} | ${scriptLines[i % scriptLines.length]} | ${
        beat === '钩子' ? '别急着划走' : beat === '痛点' ? '是不是很烦' : beat === '卖点' ? first.slice(0, 8) : beat === '背书' ? '真实使用' : '点击左下角'
      } | ${i === 0 ? '重低音卡点' : beat === '痛点' ? '轻微叹息音效' : beat === '卖点' ? '细节音+轻快BGM' : beat === '背书' ? 'BGM 降音量' : '鼓点收尾'} |`
    );
  }

  return `## 分镜脚本（总时长 ${total} 秒 / ${n} 个镜头）

| 镜号 | 时间 | 画面/运镜 | 口播台词 | 字幕 | 音效/BGM |
| --- | --- | --- | --- | --- | --- |
${shots.join('\n')}

## 拍摄要点
1. 竖屏 9:16，开启防抖，主机位固定在三脚架上。
2. 前 3 秒不要片头、不要 logo、不要"大家好"，直接上钩子。
3. 卖点镜头必须给特写：微距、慢动作、拆解各来一个。
4. 光线用自然光或柔光箱，避免顶光造成商品阴影。
5. 每 3-5 秒切一次镜头，保持节奏。
6. 字幕用大字描边，位置避开左下角（小黄车会挡住）。

## 道具与场景清单
- ${name}
- 拍摄手机 + 三脚架 + 补光灯
- 干净的纯色桌面背景
- 场景演示道具（配合${usage}）
- 清洁布（拍特写前擦干净${cat}）${DEMO_NOTE}`;
}

/* ---------- 批量变体（演示） ---------- */
const ANGLES = ['痛点型', '反常识', '结果前置', '身份代入', '避坑型', '悬念型', '价格型', '对比型', '情感共鸣', '场景还原'];

function variantSet(scene, form, count) {
  const { name, cat, audience, price, first, points, usage } = ctx(form);
  const n = Math.max(2, Math.min(10, Number(count) || 3));
  const key = points[0] || first;

  const blocks = [];
  for (let i = 0; i < n; i++) {
    const angle = ANGLES[i % ANGLES.length];
    const hook = [
      `别再乱买${cat}了，${first}才是关键。`,
      `我把它拆开看了三遍，才知道之前都买错了。`,
      `用了它之后，我把旧的那套直接扔了。`,
      `${audience}注意，这条能帮你少走弯路。`,
      `图便宜买的${cat}，最后都成了家里堆着的东西。`,
      `${name}到底值不值？我拆开给你看。`,
      `${price}，这配置有点出乎意料。`,
      `跟普通${cat}比一次，差距就出来了。`,
      `我妈用完第一句就是：这个挺好用。`,
      `${usage}的时候，你就能感受到区别。`,
    ][i % 10];

    if (scene === 'title') {
      blocks.push(`### 变体${i + 1} · ${angle}
**标题**：${hook.replace(/[。？]$/, '')}（≤22字需自行精简）
**封面大字**：${key.slice(0, 8)}
**话题标签**：#${cat} #好物推荐 #${audience} #平价好物 #${cat}怎么选
**切入点**：以「${angle}」切入，主打${i % 2 ? '信任感' : '新鲜感'}。`);
    } else {
      blocks.push(`### 变体${i + 1} · ${angle}
**钩子**：${hook}
**痛点**：${usage}的时候，别人三两下就搞定，你折腾半天还不行，越弄越烦。
**核心卖点**：
- ${key}，${usage}直接用得上，不用研究说明书
- 细节做工经得起放大看，不是一次性用品
**逼单**：点左下角小黄车先加购，不合适随时退。`);
    }
  }
  return blocks.join('\n\n') + DEMO_NOTE;
}

/* ---------- 段落重写（演示） ---------- */
function rewriteSection({ sectionTitle, sectionText, form }) {
  const { first, usage, name } = ctx(form);
  const alt = [
    `换个说法：${sectionTitle}这块，核心就一句 —— 别人还在凑合，你已经在用对的了。`,
    `把原来的信息换成更口语、更有画面的表达。原来的方向是对的，但少了具体场景。`,
    `结合${usage}的真实场景重写一版，让用户一眼看到自己。`,
  ];
  return `（演示模式）以下为占位式重写，用于体验"局部重写"交互，不构成真实改写效果：

${alt.join('\n')}

原模块要点回顾：${String(sectionText || '').replace(/\s+/g, ' ').slice(0, 60)}…
建议突出：${first}、${name} 在${usage}里的实际表现。`;
}

const BUILDERS = { talk: talkScript, title: titleSet, storyboard };

function buildDemo(scene, form, ctx2 = {}) {
  if (ctx2.count > 1 && VARIANT_SCENES.includes(scene)) return variantSet(scene, form, ctx2.count);
  return (BUILDERS[scene] || talkScript)(form || {});
}

const VARIANT_SCENES = ['talk', 'title'];

module.exports = { buildDemo, rewriteSection, VARIANT_SCENES, DEMO_NOTE };
