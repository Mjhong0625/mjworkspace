require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const cron = require("node-cron");
const { parseMessage, parseImageMessage } = require("./claude");
const {
  addTask,
  loadEntities,
  addEntity,
  getTasksSheet,
  findPendingTasksByKeyword,
  markTaskDoneByRow,
  normalizeTaskId,
  getRowById,
  updateTaskFields,
  cancelRowsWithNote,
  getAllPendingTasks,
  getOverdueHardDeadlineTasks,
  bumpReminder,
  shouldRemindAgain,
  loadConfig,
  loadPersonaNotes,
  addPersonaNote,
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
// 上一次完成侦测如果找到多个候选，先记住，让MJ可以直接说"都完成了"一次性打勾
let pendingDoneCandidates = null;

const ALL_DONE_PATTERN = /(都|全部|三个都|两个都|全都|统统|通通).*(完成|好了|做完|搞定|解决)/;

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 自然口语化的确认开场，随机挑一个
const CONFIRM_OPENERS = ["好，这个记下了", "收到，帮你记好了", "OK，记下来了", "了解，记好了", "诶好，记下了"];
function randomOpener() {
  return CONFIRM_OPENERS[Math.floor(Math.random() * CONFIRM_OPENERS.length)];
}

const HELP_TEXT =
  "秘书在line上 📋\n直接跟我说要做什么事，我会记下来；说「做完了/搞定了」我也听得懂，会自动帮你打勾。截图/照片也可以直接传给我，我会看内容判断有没有任务。\n\n下面按钮可以快速操作，也可以照旧打指令：\n/list 查看待处理任务\n/done 任务ID 标记完成\n/cancel 任务ID 取消任务";

// --- 清单文字组装（纯函式，供 /list、今日任务、每日提醒共用） ---
function buildTaskListMessage(pending, title) {
  if (pending.length === 0) return null;

  const sorted = [...pending].sort((a, b) => {
    const da = a.get("日期") || "9999-99-99";
    const db = b.get("日期") || "9999-99-99";
    return da.localeCompare(db);
  });

  const groups = {};
  for (const r of sorted) {
    const project = r.get("关联客户项目") || "其他";
    if (!groups[project]) groups[project] = [];
    groups[project].push(r);
  }

  let message = `<b>${title}</b> · 共${sorted.length}项\n`;

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
  return message.trim();
}

// --- /list 与 今日任务 共用的清单渲染 ---
async function renderTaskList(ctx, { todayOnly = false } = {}) {
  try {
    let pending = await getAllPendingTasks();

    if (todayOnly) {
      const today = new Date().toISOString().split("T")[0];
      pending = pending.filter((r) => (r.get("日期") || "") === today);
    }

    if (pending.length === 0) {
      await ctx.reply(todayOnly ? "今天没有排定的任务，轻松一天 🙂" : "目前没有待处理的任务 🎉");
      return;
    }

    const message = buildTaskListMessage(pending, todayOnly ? "今日任务" : "待处理任务");
    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    console.error("清单读取失败:", err);
    await ctx.reply("⚠️ 读取任务列表失败。");
  }
}

// --- 完成侦测共用逻辑（文字/按钮/图片都会用到） ---
async function tryMarkDoneByHint(ctx, hint, logTag) {
  const matches = await findPendingTasksByKeyword(hint);
  console.log(`[${logTag}] hint="${hint}" 匹配到${matches.length}项`);

  if (matches.length === 1) {
    await markTaskDoneByRow(matches[0]);
    const title = matches[0].get("标题") || matches[0].get("内容");
    await ctx.reply(`✓ 太好了，${escapeHtml(title)} 已标记完成`, { parse_mode: "HTML" });
    pendingDoneCandidates = null;
  } else if (matches.length > 1) {
    pendingDoneCandidates = matches; // 记住候选，MJ接着说"都完成了"就能一次性处理
    const lines = matches
      .map((r) => `<code>${r.get("任务ID")}</code> — ${escapeHtml(r.get("标题") || r.get("内容"))}`)
      .join("\n");
    await ctx.reply(
      `找到好几个可能符合的，麻烦告诉我是哪个（/done 任务ID），或者直接说"都完成了"一次全部打勾：\n${lines}`,
      { parse_mode: "HTML" }
    );
  } else {
    pendingDoneCandidates = null;
    await ctx.reply("没找到对应的待办，如果这件事之前没记录过，就不用管这句了 👌");
  }
}

// --- 处理"取消既有任务"的自然语言请求 ---
async function handleCancelIds(ctx, rawIds) {
  try {
    const ids = rawIds.map((raw) => normalizeTaskId(raw)).filter(Boolean);
    const uniqueIds = [...new Set(ids)];

    const found = [];
    const notFound = [];
    for (const id of uniqueIds) {
      const row = await getRowById(id);
      if (row && (row.get("状态") || "") !== "取消") {
        row.set("状态", "取消");
        await row.save();
        found.push(id);
      } else if (!row) {
        notFound.push(id);
      }
    }

    if (found.length > 0) {
      await ctx.reply(`— 已取消：${found.join("、")}`);
    }
    if (notFound.length > 0) {
      await ctx.reply(`找不到：${notFound.join("、")}，麻烦确认一下编号`);
    }
  } catch (err) {
    console.error("cancel_ids处理失败:", err);
    await ctx.reply("⚠️ 取消任务的时候出了点问题。");
  }
}

// --- 处理"修改/合并现有任务"的请求 ---
async function handleEditAction(ctx, editAction) {
  try {
    const ids = editAction.target_ids.map((raw) => normalizeTaskId(raw)).filter(Boolean);
    const uniqueIds = [...new Set(ids)];

    const rows = [];
    for (const id of uniqueIds) {
      const row = await getRowById(id);
      if (row) rows.push(row);
    }

    if (rows.length === 0) {
      await ctx.reply("没找到你说的那些任务ID，麻烦确认一下编号 🤔");
      return;
    }

    const fields = {
      title: editAction.new_title || "",
      detail: editAction.new_detail || "",
      date: editAction.new_date || "",
      time: editAction.new_time || "",
      project: editAction.new_project || "",
    };

    if (rows.length === 1) {
      await updateTaskFields(rows[0], fields);
      const id = rows[0].get("任务ID");
      const title = rows[0].get("标题");
      await ctx.reply(`✓ ${id} 已更新：${escapeHtml(title)}`, { parse_mode: "HTML" });
      return;
    }

    // 多个ID：保留第一个作为存活任务，其余取消，并注记合并去向
    const [survivor, ...rest] = rows;
    await updateTaskFields(survivor, fields);
    await cancelRowsWithNote(rest, `已合并入 ${survivor.get("任务ID")}`);

    const survivorId = survivor.get("任务ID");
    const survivorTitle = survivor.get("标题");
    const mergedIds = rest.map((r) => r.get("任务ID")).join("、");
    await ctx.reply(
      `✓ 已合并：${mergedIds} → ${survivorId}\n<b>${escapeHtml(survivorTitle)}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("edit_action处理失败:", err);
    await ctx.reply("⚠️ 修改任务的时候出了点问题。");
  }
}

// --- 处理Haiku解析结果的共用逻辑（文字消息、图片消息都走这里） ---
async function handleParsedResult(ctx, result, rawMessageForStorage) {
  if (result.persona_note) {
    addPersonaNote(result.persona_note).catch((err) => console.error("persona_note保存失败:", err));
  }

  if (result.empathy_note) {
    await ctx.reply(result.empathy_note);
  }

  if (result.reply) {
    await ctx.reply(result.reply);
  }

  if (result.edit_action && result.edit_action.target_ids && result.edit_action.target_ids.length > 0) {
    await handleEditAction(ctx, result.edit_action);
  }

  if (result.cancel_ids && result.cancel_ids.length > 0) {
    await handleCancelIds(ctx, result.cancel_ids);
  }

  if (result.done_hint) {
    await tryMarkDoneByHint(ctx, result.done_hint, "完成侦测");
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
      raw_message: rawMessageForStorage,
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
  if ([BTN_LIST, BTN_DONE, BTN_TODAY, BTN_HELP].includes(userMessage)) return;

  // 如果上一轮有多个候选任务，且这句话是"都完成了"这类一次性确认，直接全部打勾
  if (pendingDoneCandidates && pendingDoneCandidates.length > 0 && ALL_DONE_PATTERN.test(userMessage)) {
    const candidates = pendingDoneCandidates;
    pendingDoneCandidates = null;
    try {
      for (const row of candidates) {
        await markTaskDoneByRow(row);
      }
      const titles = candidates.map((r) => escapeHtml(r.get("标题") || r.get("内容"))).join("、");
      await ctx.reply(`✓ 太好了，全部标记完成：${titles}`, { parse_mode: "HTML" });
    } catch (err) {
      console.error("批量完成失败:", err);
      await ctx.reply("⚠️ 批量标记的时候出了点问题。");
    }
    return;
  }

  if (awaitingDoneTarget) {
    awaitingDoneTarget = false;
    try {
      await tryMarkDoneByHint(ctx, userMessage, "完成侦测-按钮");
    } catch (err) {
      console.error("按钮完成流程失败:", err);
      await ctx.reply("⚠️ 处理的时候出了点问题，再试一次？");
    }
    return;
  }

  try {
    const entities = await loadEntities();
    const personaNotes = await loadPersonaNotes();
    const result = await parseMessage(userMessage, entities, personaNotes);
    await handleParsedResult(ctx, result, userMessage);
  } catch (err) {
    console.error("处理消息失败:", err);
    await ctx.reply("⚠️ 记录的时候出了点问题，稍后再试一次，或者检查一下log。");
  }
});

// --- 图片消息：下载→转base64→丢给Claude读图 ---
bot.on("photo", async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1]; // Telegram会给多个尺寸，取最大的
    const fileLink = await ctx.telegram.getFileLink(largest.file_id);

    const res = await fetch(fileLink.href);
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const caption = (ctx.message.caption || "").trim();
    const entities = await loadEntities();
    const personaNotes = await loadPersonaNotes();
    const result = await parseImageMessage(base64, "image/jpeg", caption, entities, personaNotes);

    const rawMessageForStorage = caption ? `[图片] ${caption}` : "[图片消息]";
    await handleParsedResult(ctx, result, rawMessageForStorage);
  } catch (err) {
    console.error("图片处理失败:", err);
    await ctx.reply("⚠️ 图片处理失败，稍后再试一次。");
  }
});

bot.launch();
console.log("MJ秘书Bot已启动...");

// --- 每天早上9点（马来西亚时区）推送待处理清单 ---
cron.schedule(
  "0 9 * * *",
  async () => {
    try {
      const pending = await getAllPendingTasks();
      if (pending.length === 0) {
        await bot.telegram.sendMessage(OWNER_ID, "早安 ☀️ 今天没有待处理的任务，轻松开始新的一天");
        return;
      }
      const message = buildTaskListMessage(pending, "早安，今天待处理");
      await bot.telegram.sendMessage(OWNER_ID, `早安 ☀️\n\n${message}`, { parse_mode: "HTML" });
      console.log("[每日提醒] 已推送");
    } catch (err) {
      console.error("[每日提醒] 失败:", err);
    }
  },
  { timezone: "Asia/Kuala_Lumpur" }
);

// --- 每小时检查一次逾期未完成的硬deadline任务，按Config设定的间隔升级提醒 ---
cron.schedule(
  "0 * * * *",
  async () => {
    try {
      const config = await loadConfig();
      const intervalHours = parseFloat(config["未完成升级提醒间隔小时"]) || 4;

      const overdue = await getOverdueHardDeadlineTasks();
      const dueForReminder = overdue.filter((r) => shouldRemindAgain(r, intervalHours));

      if (dueForReminder.length === 0) return;

      const lines = dueForReminder.map((r) => {
        const title = r.get("标题") || r.get("内容");
        const id = r.get("任务ID");
        const date = r.get("日期");
        const time = r.get("时间") ? ` ${r.get("时间")}` : "";
        return `⚠️ <code>${id}</code> ${escapeHtml(title)}\n<i>已逾期 · 原定 ${date}${time}</i>`;
      });

      await bot.telegram.sendMessage(OWNER_ID, `这几件事逾期还没打勾：\n\n${lines.join("\n\n")}`, {
        parse_mode: "HTML",
      });

      for (const row of dueForReminder) {
        await bumpReminder(row);
      }
      console.log(`[逾期提醒] 推送了${dueForReminder.length}项`);
    } catch (err) {
      console.error("[逾期提醒] 失败:", err);
    }
  },
  { timezone: "Asia/Kuala_Lumpur" }
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
