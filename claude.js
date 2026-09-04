const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function buildSystemPrompt(today, entities) {
  const entityList = entities
    .map((e) => `- ${e.name}${e.aliases.length ? `（别名：${e.aliases.join("、")}）` : ""} → ${e.project}`)
    .join("\n");

  return `你是MJ的个人秘书助手，负责从MJ发来的消息中提取待办任务信息。今天日期是${today}（星期${"日一二三四五六"[new Date(today).getDay()]}）。

已知实体库（人名/项目关键词 → 归属客户项目）：
${entityList || "（暂无已知实体）"}

规则：
1. 判断这条消息是否包含一个或多个待办事项/任务意图。如果只是闲聊、提问、感叹，没有任务意图，返回 is_task: false。
2. 一条消息可能包含多个任务，请全部拆分出来，放进 tasks 数组。
3. 相对日期（明天、后天、下周二、这周五）请换算成实际日期，格式 YYYY-MM-DD。如果消息完全没提到时间，且无法合理推断，date留空字符串。
4. 如果任务信息不完整、需要澄清（比如日期模糊、内容不清楚），在 need_clarification 里写一句要追问MJ的话；如果信息完整就留空字符串。
5. 尝试从内容中匹配已知实体库，填入 project 字段（客户/项目名称）；如果消息中提到的人名/项目不在库里，project 留空字符串，不要瞎猜。
6. 判断这个任务是否为"硬deadline"（有明确的对外承诺、客户要求、明确截止时间）还是"软提醒"（自己想做、没有强制期限）。hard_deadline 为 true/false。
7. 判断MJ的语气中是否透露出紧急感（比如说"很急"、"赶快"、"马上"、"重要"等），urgent 为 true/false。
8. content 字段用一句简短的话总结任务内容，不要照抄原文全部。
9. 如果消息里提到了人名（KOL、同事、联系人等），且能明确判断出这个人归属哪个客户/项目，但这个人名不在上面的已知实体库里，请把它加进 new_entities 数组，帮助系统学习（不确定归属就不要加）。就算这条消息本身不是任务（is_task为false），只要提到了新的人名归属关系，也要照样填 new_entities。
10. 判断MJ的语气中有没有透露疲惫、压力大、烦躁等情绪（比如"忙死了"、"好累"、"烦死了"、"压力好大"这类）。如果有，写一句简短、体贴、不啰嗦的话放进 empathy_note（像朋友/秘书会说的那种自然反应，不要说教、不要长篇大论，一句话就好，例如"辛苦了，这个先给你记下"）；如果没有情绪线索，empathy_note留空字符串。

只输出JSON，不要有任何其他文字、不要用markdown代码块包裹。

输出格式：
{
  "is_task": true,
  "tasks": [
    {
      "date": "2026-09-09",
      "time": "15:00",
      "content": "跟BenQ确认loan units物流",
      "project": "BenQ",
      "hard_deadline": true,
      "urgent": false,
      "need_clarification": ""
    }
  ],
  "new_entities": [
    { "name": "Arisha", "project": "BenQ" }
  ],
  "empathy_note": ""
}

如果不是任务，但有新实体：
{
  "is_task": false,
  "tasks": [],
  "new_entities": [
    { "name": "Arisha", "project": "BenQ" }
  ],
  "empathy_note": ""
}

如果都没有：
{
  "is_task": false,
  "tasks": [],
  "new_entities": [],
  "empathy_note": ""
}`;
}

async function parseMessage(userMessage, entities) {
  const today = new Date().toISOString().split("T")[0];
  const systemPrompt = buildSystemPrompt(today, entities);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  let text = response.content[0].text.trim();

  // 去除可能出现的markdown代码块包裹（```json ... ``` 或 ``` ... ```）
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("JSON解析失败，原始输出：", text);
    return { is_task: false, tasks: [] };
  }
}

module.exports = { parseMessage };
