require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { parseMessage } = require("./claude");
const {
  addTask,
  loadEntities,
  addEntity,
  getTasksSheet,
  findPendingTasksByKeyword,
  markTaskDoneByRow,
} = require("./sheets");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const OWNER_ID = String(process.env.OWNER_TELEGRAM_ID || "");

const BTN_LIST = "📋 待处理任务";
const BTN_DONE = "✅ 标记完成";
const BTN_TODAY = "📅 今日任务";
const BTN_HELP = "❓ 使用说明";

const mainMenu = Markup.keyboard([[BTN_LIST, BTN_DONE], [BTN_TODAY, BTN_HELP]]).resize();

// 单人使用，用内存记录"是否正在等待完成目标"的状态即可，不需要持久化
let awaitingDoneTarget = false;

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 自然口语化的确认开场，随机挑一个
const CONFIRM_OPENERS = ["好，这个记下了", "收到，帮你记好了", "OK，记下来了", "了解，记好了", "诶好，记下了"];
function randomOpener() {
  return CONFIRM_OPENERS[Math.floor(Math.random() * CONFIRM_OPENERS.length)];
}

const HELP_TEXT =
  "秘书在line上 📋\n直接跟我说要做什么事，我会记下来；说「做完了/搞定了」我也听得懂，会自动帮你打勾。\n\n下面按钮可以快速操作，也可以照旧打指令：\n/list 查看待处理任务\n/done 任务ID 标记完成\n/cancel 任务ID 取消任务";

// --- /list 与 今日任务 共用的清单渲染 ---
async function renderTaskList(ctx, { todayOnly = false } = {}) {
  try {
    const sheet = await getTasksSheet();
    const rows = await sheet.getRows();
    let pending = rows.filter((r) => (r.get("状态") || "") === "待处理");

    if (todayOnly) {
      const today = new Date().toISOString().split("T")[0];
      pending = pending.filter((r) => (r.get("日期") || "") === today);
    }

    if (pending.length === 0) {
      await ctx.reply(todayOnly ? "今天没有排定的任务，轻松一天 🙂" : "目前没有待处理的任务 🎉");
      return;
    }

    pending.sort((a, b) => {
      const da = a.get("日期") || "9999-99-99";
      const db = b.get("日期") || "9999-99-99";
      return da.localeCompare(db);
    });

    const groups = {};
    for (const r of pending) {
      const project = r.get("关联客户项目") || "其他";
      if (!groups[project]) groups[project] = [];
      groups[project].push(r);
    }

    const title = todayOnly ? "今日任务" : "待处理任务";
    let message = `<b>${title}</b> · 共${pending.length}项\n`;

    for (const [project, items] of Object.entries(groups)) {
      message += `\n<b>📁 ${escapeHtml(project)}</b>\n`;
      items.forEach((r, idx) => {
        const id = r.get("任务ID");
        const date = r.get("日期") || "未定日期";
        const time = r.get("时间") ? ` ${r.get("时间")}` : "";
        const taskTitle = escapeHtml(r.get("标题") || r.get("内容"));
        const urgent = r.get("紧急标记") === "是" ? " 🔴" : "";
        message += `${idx + 1}. ${taskTitle}${urgent}\n<i>${date}${time} · ${id}</i>\n\n`;
      });
    }

    message += `<i>完成用 /done 任务ID，或直接点「${BTN_DONE}」</i>`;

    await ctx.reply(message.trim(), { parse_mode: "HTML" });
  } catch (err) {
    console.error("清单读取失败:", err);
    await ctx.reply("⚠️ 读取任务列表失败。");
  }
}

// --- 身份验证：只回应主人 ---
bot.use((ctx, next) => {
  const fromId = String(ctx.from && ctx.from.id);
  if (!OWNER_ID || fromId !== OWNER_ID) {
    console.log(`[拦截] 非主人消息，来自ID: ${fromId}`);
    return;
  }
  return next();
});

bot.start((ctx) => {
  ctx.reply(HELP_TEXT, mainMenu);
});

// --- 指令：/list /done /cancel ---
bot.command("list", (ctx) => renderTaskList(ctx));

bot.command("done", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const taskId = parts[1];
  if (!taskId) {
    await ctx.reply("用法：/done T0001");
    return;
  }

  try {
    const sheet = await getTasksSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => (r.get("任务ID") || "") === taskId);

    if (!row) {
      await ctx.reply(`找不到任务 ${taskId}`);
      return;
    }

    await markTaskDoneByRow(row);
    await ctx.reply(`✓ ${taskId} 已标记完成`);
  } catch (err) {
    console.error("/done 失败:", err);
    await ctx.reply("⚠️ 标记完成失败。");
  }
});

bot.command("cancel", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const taskId = parts[1];
  if (!taskId) {
    await ctx.reply("用法：/cancel T0001");
    return;
  }

  try {
    const sheet = await getTasksSheet();
    const rows = await sheet.getRows();
    const row = rows.find((r) => (r.get("任务ID") || "") === taskId);

    if (!row) {
      await ctx.reply(`找不到任务 ${taskId}`);
      return;
    }

    row.set("状态", "取消");
    await row.save();

    await ctx.reply(`— ${taskId} 已取消`);
  } catch (err) {
    console.error("/cancel 失败:", err);
    await ctx.reply("⚠️ 取消失败。");
  }
});

// --- 主选单按钮 ---
bot.hears(BTN_LIST, (ctx) => renderTaskList(ctx));
bot.hears(BTN_TODAY, (ctx) => renderTaskList(ctx, { todayOnly: true }));
bot.hears(BTN_HELP, (ctx) => ctx.reply(HELP_TEXT, mainMenu));
bot.hears(BTN_DONE, async (ctx) => {
  awaitingDoneTarget = true;
  await ctx.reply("要完成哪一件？直接说说看就好，比如「BenQ的loan units那个」");
});

// --- 核心：接收文字消息 → 解析 → 写入 ---
bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text.trim();
  if (userMessage.startsWith("/")) return;
  // 按钮文字已被上面的 bot.hears 处理，这里不重复处理
  if ([BTN_LIST, BTN_DONE, BTN_TODAY, BTN_HELP].includes(userMessage)) return;

  // 如果正在等待"完成哪一件"的回复，这条消息直接拿去比对，不走一般任务解析
  if (awaitingDoneTarget) {
    awaitingDoneTarget = false;
    try {
      const matches = await findPendingTasksByKeyword(userMessage);
      console.log(`[完成侦测-按钮] 输入="${userMessage}" 匹配到${matches.length}项`);

      if (matches.length === 1) {
        await markTaskDoneByRow(matches[0]);
        const title = matches[0].get("标题") || matches[0].get("内容");
        await ctx.reply(`✓ 太好了，${escapeHtml(title)} 已标记完成`, { parse_mode: "HTML" });
      } else if (matches.length > 1) {
        const lines = matches
          .map((r) => `<code>${r.get("任务ID")}</code> — ${escapeHtml(r.get("标题") || r.get("内容"))}`)
          .join("\n");
        await ctx.reply(`找到好几个可能符合的，麻烦告诉我是哪个（/done 任务ID）：\n${lines}`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply("没找到对应的待办，如果这件事之前没记录过，就不用管这句了 👌");
      }
    } catch (err) {
      console.error("按钮完成流程失败:", err);
      await ctx.reply("⚠️ 处理的时候出了点问题，再试一次？");
    }
    return;
  }

  try {
    const entities = await loadEntities();
    const result = await parseMessage(userMessage, entities);

    if (result.empathy_note) {
      await ctx.reply(result.empathy_note);
    }

    if (result.done_hint) {
      const matches = await findPendingTasksByKeyword(result.done_hint);
      console.log(`[完成侦测] done_hint="${result.done_hint}" 匹配到${matches.length}项`);

      if (matches.length === 1) {
        await markTaskDoneByRow(matches[0]);
        const title = matches[0].get("标题") || matches[0].get("内容");
        await ctx.reply(`✓ 太好了，${escapeHtml(title)} 已标记完成`, { parse_mode: "HTML" });
      } else if (matches.length > 1) {
        const lines = matches
          .map((r) => `<code>${r.get("任务ID")}</code> — ${escapeHtml(r.get("标题") || r.get("内容"))}`)
          .join("\n");
        await ctx.reply(`找到好几个可能符合的，麻烦告诉我是哪个（/done 任务ID）：\n${lines}`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply("没找到对应的待办，如果这件事之前没记录过，就不用管这句了 👌");
      }
    }

    if (result.reply) {
      await ctx.reply(result.reply);
    }

    const learnedLines = [];
    if (result.new_entities && result.new_entities.length > 0) {
      for (const ent of result.new_entities) {
        if (!ent.name || !ent.project) continue;
        const added = await addEntity(ent.name, ent.project);
        if (added) learnedLines.push(`📌 学起来了：${ent.name} → ${ent.project}`);
      }
    }

    if (!result.is_task || !result.tasks || result.tasks.length === 0) {
      if (learnedLines.length > 0) {
        await ctx.reply(learnedLines.join("\n"));
      }
      return;
    }

    const confirmLines = [];

    for (const task of result.tasks) {
      if (task.need_clarification) {
        await ctx.reply(`❓ ${task.need_clarification}`);
        continue;
      }

      const id = await addTask({
        date: task.date,
        time: task.time,
        title: task.title,
        detail: task.detail,
        project: task.project,
        urgent: task.urgent,
        hard_deadline: task.hard_deadline,
        raw_message: userMessage,
      });

      const dateLabel = task.date ? task.date : "未定日期";
      const timeLabel = task.time ? ` ${task.time}` : "";
      const projectLabel = task.project ? `[${escapeHtml(task.project)}] ` : "";
      const urgentLabel = task.urgent ? " 🔴急" : "";
      confirmLines.push(
        `<code>${id}</code> ${dateLabel}${timeLabel}${urgentLabel}\n<b>${projectLabel}${escapeHtml(task.title)}</b>\n<i>${escapeHtml(task.detail)}</i>`
      );
    }

    if (confirmLines.length > 0) {
      await ctx.reply([randomOpener(), ...learnedLines, ...confirmLines].join("\n"), { parse_mode: "HTML" });
    } else if (learnedLines.length > 0) {
      await ctx.reply(learnedLines.join("\n"));
    }
  } catch (err) {
    console.error("处理消息失败:", err);
    await ctx.reply("⚠️ 记录的时候出了点问题，稍后再试一次，或者检查一下log。");
  }
});

bot.launch();
console.log("MJ秘书Bot已启动...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
