'use strict';
/**
 * 抖音带货爆款文案的 Prompt 工程
 * 场景：口播脚本(talk) / 标题与话题(title) / 短视频分镜(storyboard)
 * 附加任务：批量变体(variant) / 段落重写(rewrite) / 商品信息提取(extract) / 主图识图(vision)
 */

const SYSTEM_PROMPT = `你是一位深耕抖音电商的爆款短视频操盘手兼编导，操盘过大量单条百万播放的带货短视频。
你的任务：根据用户给出的商品信息，产出可以直接落地拍摄、并且符合抖音流量分发逻辑的带货文案。

【必须遵守的铁律】
1. 黄金3秒：开头必须用钩子抓住用户，严禁"大家好""今天给大家分享""欢迎来到我的直播间"这类废话开场。
2. 符合算法偏好：完播率 > 互动率 > 转化率。文案要有留人结构（悬念 / 反常识 / 痛点前置 / 结果前置 / 身份代入）。
3. 极度口语化：像跟朋友唠嗑，多用短句和语气词，单句不超过 20 个字。禁止书面语、禁止行业黑话、禁止"赋能/闭环/打造"这类词。
4. 有画面感：多写具体的时间、地点、动作、数字、感官细节，少写抽象形容词。
5. 痛点要真实：写用户日常真的会烦躁的具体场景，先共鸣、再给方案。
6. 卖点要翻译：把参数翻译成用户能感知的好处（"续航8小时"→"出门一整天不用到处找充电口"），用对比和数字制造可信度。
7. 必须有行动指令(CTA)：明确告诉用户"现在点哪里、做什么"。
8. 合规红线（非常重要）：
   - 禁止极限词：最、第一、唯一、顶级、国家级、绝对、100%、史上、全网最低。
   - 禁止医疗与功效承诺：治好、根治、祛除、瘦X斤、三天见效、无副作用。
   - 禁止虚假限时与虚假原价，价格与优惠必须用用户提供的真实信息，不要自己编造。
   - 禁止站外导流与诱导互动：加微信、私聊、点赞抽奖、集赞、砍一刀。
   - 不得贬低同行或指名对比竞品品牌。
9. 只输出用户要求的内容，不要写"好的""以下是"这类开场，也不要写任何解释、总结、注意事项（除非用户要求）。
10. 使用简体中文，输出 Markdown 格式。

【差异化约束（核心竞争力）】
1. 不要直接复用网上已有爆款文案的句式、钩子、卖点话术——要在借鉴爆款结构（钩子-痛点-卖点-背书-CTA）的基础上做**差异化延展**，换个方向、换个角度、换个说法。
2. 差异化的四个方向（至少用其中两个）：
   - **换场景**：把"上班族地铁上补妆"换成"宝妈送完孩子在车里补妆"
   - **换人群**：把"所有女生"换成"35+ 办公室久坐的腰突患者"
   - **换情绪角度**：把"痛点→解决"换成"结果前置→反常识原因"或"自嘲→共鸣→方案"
   - **换表达方式**：把"参数罗列"换成"实测数据故事"或"用闺蜜聊天口替代导购口"
3. 钩子必须原创——不要"女人就要对自己好一点"这种大街款钩子，要具体、有画面、有悬念。例："你是不是也发现，早上赶时间时手机电量掉得特别快？"（场景化 + 痛点）而不是"手机续航不够用怎么办？"（大路货）。
4. 卖点翻译必须具体——不要"续航时间长"，要"出门一整天从地铁到下班到接娃，回家还剩 40%"（具体场景 + 真实数字 + 用户感知）。
5. 产出多个变体时，各变体的切入角度必须真正不同，不能只换几个词就叫"新版本"。每个变体选一个独特的切入口，让用户一眼能看出差异。

【商品信息为空时的处理】
若用户未提供某个字段，基于品类常识合理补全，并在该内容后用（）标注推测项，例如（推测）。
绝不要编造具体的价格、销量、检测报告编号这类可被验证的硬数据。`;

const DURATION_HINT = {
  '15': '视频总时长约 15 秒，节奏极快，只留最狠的一个痛点和最狠的一个卖点，台词总量控制在 55 字以内。',
  '30': '视频总时长约 30 秒，可以走"痛点-卖点-背书-逼单"完整结构，台词总量控制在 130 字以内。',
  '60': '视频总时长约 60 秒，可以有完整的场景故事和多个卖点展开，台词总量控制在 280 字以内。',
};

const TONES = {
  接地气: '风格：接地气、实在，像个热心邻居在真心推荐，多用生活化比喻。',
  幽默: '风格：幽默、有梗，制造反差和意外感，让人想笑出来。',
  专业测评: '风格：专业测评风，用参数对比、实测数据、细节特写建立信任感，但依然口语化。',
  情感共鸣: '风格：情感共鸣，先讲故事戳情绪，再自然带出商品。',
  反差搞笑: '风格：反差搞笑，通过夸张的对比和自黑制造记忆点。',
  质感高端: '风格：克制的高级感，少即是多，用细节和态度体现品质。',
};

/* ============ 单版本输出结构 ============ */
const SCENE_SPECS = {
  talk: `【输出任务】产出一份可以直接照着念的口播脚本。

严格按以下模块输出，模块标题用 Markdown 二级标题（##）原样保留：

## 黄金3秒钩子
给出 1 条主钩子 + 2 条备选钩子，每条单独一行，行首用 "主选：" / "备选1：" / "备选2：" 标注。
钩子类型在括号里注明，如（反常识）、（痛点）、（悬念）、（结果前置）。

## 痛点共鸣
2-3 句，写出用户在真实生活里遇到这个问题的具体场景，要有细节，让人有"这说的就是我"的感觉。

## 产品亮相 + 核心卖点
至少 3 个卖点，每个卖点用一行 "卖点：... ｜ 怎么说：..." 的形式：
- "卖点" 写商品客观优势；
- "怎么说" 写成能直接念出来的大白话，必须包含具体场景或数字对比。

## 信任背书
1-2 句，用可感知的方式建立信任（实测体验、使用天数、材质细节、售后承诺），不要编造检测报告编号和销量数据。

## 逼单 CTA
2 句，制造合理紧迫感 + 明确指令（点小黄车 / 点左下角 / 加购），不要用虚假倒计时。

## 拍摄提示
3-5 条要点，写清楚机位、景别、运镜、语速节奏、重点动作。`,

  title: `【输出任务】产出一套用于投放的标题、封面大字和话题标签。

严格按以下模块输出，模块标题用 Markdown 二级标题（##）原样保留：

## 视频标题
10 条，每条一行并用 "1. " 编号，每条不超过 22 个字。
要求覆盖不同角度：痛点型、悬念型、反常识型、结果型、身份代入型、价格型、对比型。
每条标题末尾用括号标注角度，如（痛点型）。

## 封面大字
5 条，每条不超过 9 个字，要能一眼看懂、有强对比和情绪，行首用 "・"。

## 话题标签
分三组输出，每组一行，标签之间用空格分隔，每个标签以 # 开头且不带空格：
### 泛流量标签
### 精准人群标签
### 品类场景标签
每组 4-6 个标签，混合大流量词和细分长尾词。

## 评论区引导话术
4 条，用来引导用户评论互动（提问式、选择题式、共鸣式），每条一行，行首用 "・"。`,

  storyboard: `【输出任务】产出一份可以直接照着拍的分镜脚本。

第一部分：用一个 Markdown 表格输出分镜，表头固定为：

| 镜号 | 时间 | 画面/运镜 | 口播台词 | 字幕 | 音效/BGM |
| --- | --- | --- | --- | --- | --- |

要求：
- 镜号从 1 开始连续编号；
- 时间列为 "0-3s" 这样的区间，必须连续衔接不跳空，总时长与用户指定时长一致；
- 镜头数量按总时长分配：15秒约 6 个镜头，30秒约 10 个镜头，60秒约 16 个镜头；
- 口播台词直接写可念的台词，无台词的镜头写"（无台词，纯画面）"；
- 字幕列写该镜头屏幕上的关键文字，不超过 8 个字；
- 音效/BGM 列写卡点、环境音或音乐情绪提示。

第二部分：表格之后按以下模块输出：

## 拍摄要点
4-6 条，包含机位、灯光、景别切换、节奏卡点提示。

## 道具与场景清单
用 "- " 列出拍摄前需要准备好的物品和场地。`,
};

/* ============ 批量变体输出结构（用加粗小标签，便于前端切卡片） ============ */
const VARIANT_SPECS = {
  talk: `每个变体内部用加粗标签分段，严格使用这几个标签，标签后直接跟内容，不要用 ## 标题：
**钩子**：一条开场钩子（3秒内，直接写能念的话）
**痛点**：1-2 句戳中用户的具体场景
**核心卖点**：2-3 行，每行写成能直接念的大白话
**逼单**：1-2 句行动指令`,

  title: `每个变体内部用加粗标签分段，严格使用这几个标签：
**标题**：1 条视频标题（≤22 字）
**封面大字**：1 条（≤9 字）
**话题标签**：一行 5-7 个标签，用空格分隔，每个以 # 开头
**切入点**：一句话说明这个版本主打什么角度`,
};

const SCENE_LABEL = { talk: '口播脚本', title: '标题与话题标签', storyboard: '分镜脚本' };

/* 并行变体的切入角度池：每次生成从中取互不重复的角度，保证变体真正不同源 */
const ANGLE_POOL = ['痛点型', '反常识', '悬念', '结果前置', '身份代入', '价格冲击', '对比测评', '场景故事', '情感共鸣', '数据实测'];

/**
 * 从角度池中选 n 个互不重复的角度
 * @param {number} n 需要数量
 * @param {string[]} exclude 需排除的已有角度（再来一版时用）
 * @param {string} [forced] 强制指定的角度（直接使用）
 */
function pickAngles(n, exclude, forced) {
  if (forced && typeof forced === 'string' && forced.trim()) return [forced.trim().slice(0, 8)];
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map((s) => String(s).trim()).filter(Boolean));
  const available = ANGLE_POOL.filter((a) => !excluded.has(a));
  // 简单洗牌，避免每次生成角度顺序固定
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  const picked = available.slice(0, Math.max(1, n));
  // 排除后不够时，基于完整角度池用带后缀的角度补齐，保证数量
  let k = 2;
  while (picked.length < n && k <= 4) {
    for (const a of ANGLE_POOL) {
      if (picked.length >= n) break;
      const alt = `${a}·${k}`;
      if (!excluded.has(alt) && !picked.includes(alt)) picked.push(alt);
    }
    k++;
  }
  return picked;
}

/* ============ 上下文拼装 ============ */
function formBlock(form) {
  const lines = [];
  lines.push(`【商品名称】${form.productName || '（未填写，请根据品类合理推测）'}`);
  lines.push(`【商品品类】${form.category || '（未填写）'}`);
  lines.push(
    `【核心卖点】${
      Array.isArray(form.sellingPoints) && form.sellingPoints.length
        ? form.sellingPoints.map((s) => String(s).trim()).filter(Boolean).join('；')
        : '（未填写，请根据品类合理推测）'
    }`
  );
  lines.push(`【目标人群】${form.audience || '（未填写，请自行判断最可能买单的人群）'}`);
  lines.push(`【价格/优惠】${form.price || '（未填写，不要编造，可用"点进去看价格"这类话术带过）'}`);
  lines.push(`【使用场景】${form.usageScene || '（未填写）'}`);
  lines.push(`【视频时长】${form.duration || '30'} 秒`);
  if (form.persona) lines.push(`【账号人设】${form.persona}`);
  if (form.tone) lines.push(`【文案风格】${form.tone}`);
  if (form.extra) lines.push(`【其他要求】${form.extra}`);

  const extra = [];
  if (DURATION_HINT[form.duration]) extra.push(`【时长要求】${DURATION_HINT[form.duration]}`);
  if (TONES[form.tone]) extra.push(TONES[form.tone]);
  return { core: lines.join('\n'), extra: extra.join('\n') };
}

function hotwordBlock(hotwords, scene) {
  if (!Array.isArray(hotwords) || !hotwords.length) return '';
  const lines = hotwords
    .filter((g) => g.words?.length)
    .map((g) => `${g.group}：${g.words.map((w) => (w.startsWith('#') ? w : '#' + w)).join(' ')}`);
  if (!lines.length) return '';
  if (scene === 'title') {
    return `【可用话题标签池】（优先从下面挑选真正相关的标签，与本商品无关的不要用；如果池子里确实不合适，可以补充 1-2 个更精准的细分长尾词。带「热榜·」前缀的是近期平台热榜词，相关时优先借用）
${lines.join('\n')}`;
  }
  return `【近期热点词池】（以下是近期平台热榜词与维护的常用标签。仅在与本商品真正相关时，在钩子、台词或话题中自然借用一两个，制造蹭热点的代入感；与本商品无关的绝对不要硬蹭，更不要为了蹭热点歪曲卖点）
${lines.join('\n')}`;
}

function sampleBlock(samples) {
  if (!Array.isArray(samples) || !samples.length) return '';
  const parts = samples.map(
    (s, i) => `--- 样例${i + 1}${s.note ? '（' + s.note + '）' : ''} ---\n${s.text}`
  );
  return `【风格参考样例】仅参考结构节奏与语感，绝对不要照抄内容，也不要复用样例里的商品信息：
${parts.join('\n\n')}`;
}

/** 历史投放数据洞察（由 A/B 分析模块产出 winners 后反哺进提示词） */
function insightBlock(insight) {
  // 人工评分维度只用于分析页对照，不参与生成注入（评分无法由模型复现）
  const winners = (insight && Array.isArray(insight.winners) ? insight.winners : []).filter((w) => w.dimension !== 'rating');
  if (!winners.length) return '';
  const lines = winners.map((w) => {
    const parts = [];
    if (w.avgRetention != null) parts.push(`平均完播率 ${w.avgRetention}%`);
    if (w.avgCvr != null) parts.push(`平均转化率 ${w.avgCvr}%`);
    if (w.gpm) parts.push(`千次播放成交约 ${w.gpm} 元`);
    return `- ${w.label}为「${w.value}」表现最好：${parts.join('，') || '综合表现最好'}（${w.count} 条已投放样本）`;
  });
  return `【你自己的历史投放数据洞察】（基于 ${insight.sampleCount || ''} 条已投放视频的真实回流数据）
${lines.join('\n')}
以上是已被数据验证更有效的打法方向，本次创作优先采用，但必须结合本商品特点自然融入，不要生硬堆砌，也不要照搬例句。产出多个变体时，在沿用最优方向的基础上仍让各版本覆盖不同切入角度，便于投放对比。`;
}

function buildUserPrompt(scene, form, ctx = {}) {
  const { core, extra } = formBlock(form);
  const count = Number(ctx.count) > 1 && scene !== 'storyboard' ? Number(ctx.count) : 1;
  const insight = insightBlock(ctx.insight);
  const blocks = [];

  if (ctx.variantMode && ctx.angle) {
    // 并行变体模式：单次请求只产出一个指定角度的紧凑变体
    blocks.push(
      `请产出 1 个「${SCENE_LABEL[scene]}」版本，切入角度指定为「${ctx.angle}」。`,
      `【输出格式（必须严格遵守）】
- 直接输出正文，不要输出 ### 变体标题，不要输出任何解释或前后缀
- ${VARIANT_SPECS[scene] || ''}
- 钩子角度、开头句式、卖点切入必须紧扣「${ctx.angle}」，与泛泛而谈的常见写法拉开差异`,
      `${SCENE_LABEL[scene]}的场景背景与要求：${SCENE_SPECS[scene]}`,
      '注意：请用上面要求的加粗标签分段，不要使用 ## 二级标题。'
    );
  } else if (count > 1) {
    blocks.push(
      `请产出 ${count} 个「${SCENE_LABEL[scene]}」的不同版本，用于投放 A/B 测试。`,
      `【输出格式（必须严格遵守）】
- 每个版本用三级标题开头，格式为：### 变体1 · 角度标签（角度标签用 2-6 个字概括该版本的切入角度，例如 痛点型 / 反常识 / 结果前置 / 身份激励）
- 版本编号从 1 连续增加到 ${count}
- ${VARIANT_SPECS[scene] || ''}
- ${count} 个版本之间，钩子角度、开头句式、卖点切入必须明显不同，不要只换几个词
- ${count} 个版本的角度标签互不重复，一条一个角度，方便投放对比
- 不要在版本之间输出任何过渡句、不要输出总结`,
      `${SCENE_LABEL[scene]}的场景背景与要求：${SCENE_SPECS[scene]}`,
      '注意：因为要输出多个变体，请用上面要求的加粗标签分段，不要使用 ## 二级标题。'
    );
  } else {
    blocks.push(`请产出「${SCENE_LABEL[scene]}」。`, SCENE_SPECS[scene]);
  }

  const sw = sampleBlock(ctx.samples);
  const hw = hotwordBlock(ctx.hotwords, scene);

  return [core, extra, insight, sw, hw, ...blocks].filter(Boolean).join('\n\n');
}

/**
 * 组装对话消息
 * @param {'talk'|'title'|'storyboard'} scene
 * @param {object} form
 * @param {{samples?:Array, hotwords?:Array, count?:number}} ctx
 */
function buildMessages(scene, form, ctx = {}) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(scene, form, ctx) },
  ];
}

/* ============ 局部重写 ============ */
function buildRewriteMessages({ scene, sectionTitle, sectionText, form, instruction }) {
  const user = `这是一份已经写好的抖音带货「${SCENE_LABEL[scene] || '文案'}」，需要你只重写其中一个模块。

【商品信息】
${formBlock(form).core}

【需要重写的模块标题】${sectionTitle}

【该模块当前内容】
${sectionText}

【重写要求】
${instruction || '保持原有信息不变，换一个更抓人的表达，节奏更快、更口语、更有画面感。'}

【输出要求】
- 只输出重写后的该模块正文，不要输出模块标题、不要输出任何解释或前后缀。
- 如果该模块原本是列表或"卖点：... ｜ 怎么说：..."这类结构化格式，请保持同样的结构。
- 严格遵守合规红线，不得使用极限词、功效承诺、站外导流话术。`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/* ============ 商品信息提取（JSON 输出） ============ */
const EXTRACT_SCHEMA = `{"productName":"商品名称","category":"品类（从 美妆护肤/食品生鲜/服饰鞋包/家居日用/数码家电/母婴亲子/个护健康/其它 中选一个）","sellingPoints":["卖点1","卖点2"],"price":"价格或优惠描述，没有就留空字符串","audience":"目标人群，推测写推测的","usageScene":"典型使用场景"}`;

function buildExtractMessages(pageText, url) {
  return [
    {
      role: 'system',
      content: `你是电商商品信息抽取助手。从给定的网页文本中提取商品信息，只输出 JSON，不要任何解释、不要 Markdown 代码块之外的内容。
严禁编造：文本中没有的价格、人群等信息一律留空字符串。卖点必须是文本中真实出现或可直接推断的商品属性，2-5 条。`,
    },
    {
      role: 'user',
      content: `页面地址：${url}
网页文本（已截断）：
"""
${String(pageText || '').slice(0, 5000)}
"""

请输出符合以下结构的 JSON：
${EXTRACT_SCHEMA}`,
    },
  ];
}

/* ============ 粘贴文本提炼（JSON 输出） ============ */
function buildParseMessages(text) {
  return [
    {
      role: 'system',
      content: `你是电商商品信息提炼助手。用户会粘贴一段商品标题、卖点等原文（可能来自淘宝/京东/拼多多/1688/抖音商城等平台的商品详情页）。请提炼成结构化 JSON，只输出 JSON，不要任何解释。
要求：
- productName：商品核心名称，去掉平台促销词（如 官方旗舰、包邮、限时秒杀、赠品信息、店铺名），保留品牌 + 品名 + 关键规格，不超过 40 字。
- category 必须从这几个里选：美妆护肤/食品生鲜/服饰鞋包/家居日用/数码家电/母婴亲子/个护健康/其它。
- sellingPoints：2-5 条，把营销话术提炼成客观、具体的卖点短语，每条不超过 20 字。
- price：只在原文出现真实价格时填写（如"39.9元"），否则留空字符串。
- audience / usageScene：能从原文推断才填，否则留空字符串。
严禁编造原文中不存在的价格、人群、场景信息。`,
    },
    {
      role: 'user',
      content: `粘贴的原文：
"""
${String(text || '').slice(0, 4000)}
"""

请输出符合以下结构的 JSON：
${EXTRACT_SCHEMA}`,
    },
  ];
}

/* ============ 热榜粘贴提炼（JSON 输出） ============ */
function buildTrendingMessages(text) {
  return [
    {
      role: 'system',
      content: `你是抖音电商热点运营助手。用户会粘贴一段平台热榜/热点原文（可能来自抖音热榜、巨量算数、蝉妈妈等榜单的复制文本或截图文字）。请提炼成结构化热词分组 JSON，只输出 JSON，不要任何解释。
要求：
- 输出结构：{"groups":[{"group":"分组名","words":["词1","词2"]}]}
- 词条清理：去掉排名序号、# 号、热度数值、（热/沸/新/爆）角标，只留热点本体，每个词 2-15 字
- 分组：按热点性质归成 2-6 组，组名用简短中文（如 社会热点 / 节日节点 / 影视娱乐 / 生活方式 / 挑战玩法 / 消费趋势）
- 明显与带货无关的时政、灾难、负面舆情词条直接丢弃
- 严禁编造原文中不存在的热点`,
    },
    {
      role: 'user',
      content: `粘贴的热榜原文：
"""
${String(text || '').slice(0, 4000)}
"""

请输出符合上述结构的 JSON。`,
    },
  ];
}

/* ============ 一键合规改写 ============ */
function buildComplianceMessages(text, hits, category) {
  const list = (hits || [])
    .filter((h) => h.sev !== 'low')
    .map((h) => `- 「${h.word}」（${h.cat}${h.suggestion ? `，可参考改法：${h.suggestion}` : ''}）`)
    .join('\n');
  return [
    {
      role: 'system',
      content: `你是抖音电商文案合规审校员。任务：把给出文案中的广告法与平台规则风险表述替换掉，其余内容一字不改。
要求：
- 只修改列出的风险表述及其紧邻的必要衔接词，其余句子、结构、标点、顺序全部保持原样
- 改写方向：把承诺改成体验、把极限词改成具体描述、把导流话术改成站内引导（点小黄车/左下角链接）
- 输出改写后的完整文案，Markdown 结构保持一致，不要输出任何解释${category ? `\n- 商品品类是「${category}」，注意该品类的宣称限制` : ''}`,
    },
    {
      role: 'user',
      content: `【原文】
"""
${String(text || '')}
"""

【需处理的风险表述】
${list || '（无）'}

请输出改写后的完整文案。`,
    },
  ];
}

function buildVisionMessages(imageDataUrl, hint) {
  return [
    {
      role: 'system',
      content: `你是电商商品图分析助手。根据商品主图提取卖点信息，只输出 JSON。
严禁编造图片中不存在的信息：看不到的价格留空字符串。卖点要写成"用户能感知的好处"，2-5 条。`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `这是商品主图${hint ? `，补充信息：${hint}` : ''}。请判断商品是什么、属于哪个品类，并提炼卖点。输出符合以下结构的 JSON：
${EXTRACT_SCHEMA}

category 必须从这几个里选：美妆护肤/食品生鲜/服饰鞋包/家居日用/数码家电/母婴亲子/个护健康/其它`,
        },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/** 投放数据截图识别：从抖音数据页截图读取 播放量/完播率/转化率/GMV */
function buildVisionMetricsMessages(imageDataUrl) {
  return [
    {
      role: 'system',
      content: `你是抖音电商数据截图识别助手。从截图读取视频投放数据，只输出 JSON。
严禁编造截图中看不到的数字：看不到的字段填 0。`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `这是抖音视频的数据截图（可能来自创作者服务中心 / 巨量千川 / 电商罗盘）。请识别并输出 JSON：
{"views": 0, "retention": 0, "cvr": 0, "gmv": 0}
规则：
- views 播放量、gmv 成交额：纯数字，"1.2万" → 12000
- retention 完播率、cvr 转化率：只填百分数的数值部分（"45.6%" → 45.6）
- 只输出 JSON 本身，不要多余文字
- 截图里看不到的字段填 0
- 若有多条视频的数据，取最新一条`,
        },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

module.exports = {
  SYSTEM_PROMPT,
  DURATION_HINT,
  TONES,
  SCENE_SPECS,
  SCENE_LABEL,
  ANGLE_POOL,
  pickAngles,
  buildMessages,
  buildUserPrompt,
  buildRewriteMessages,
  buildExtractMessages,
  buildParseMessages,
  buildTrendingMessages,
  buildComplianceMessages,
  buildVisionMessages,
  buildVisionMetricsMessages,
  insightBlock,
  EXTRACT_SCHEMA,
};
