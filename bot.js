require("dotenv").config();
const { Telegraf } = require("telegraf");
const { parseMessage } = require("./claude");
const { addTask, loadEntities, addEntity, getTasksSheet } = require("./sheets");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const OWNER_ID = String(process.env.OWNER_TELEGRAM_ID || "");

// --- 身份验证：只回应主人 ---
bot.use((ctx, next) => {
  const fromId = String(ctx.from && ctx.from.id);
  if (!OWNER_ID || fromId !== OWNER_ID) {
    console.log(`[拦截] 非主人消息，来自ID: ${fromId}`);
    return; // 静默不回应
  }
  return next();
});

bot.start((ctx) => {
  ctx.reply("MJ秘书已上线 📋\n直接跟我说要做什么事，我会帮你记下来。\n\n指令：\n/list 查看待处理任务\n/done [任务ID] 标记完成\n/cancel [任务ID] 取消任务");
});

// --- 核心：接收文字消息 → 解析 → 写入 ---
bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text.trim();
  if (userMessage.startsWith("/")) return; // 指令交给对应handler

  try {
    const entities = await loadEntities();
    const result = await parseMessage(userMessage, entities);

    // 无论是否为任务，都先处理消息里学到的新实体
    const learnedLines = [];
    if (result.new_entities && result.new_entities.length > 0) {
      for (const ent of result.new_entities) {
        if (!ent.name || !ent.project) continue;
        const added = await addEntity(ent.name, ent.project);
        if (added) learnedLines.push(`🧠 已学习：${ent.name} → ${ent.project}`);
      }
    }

    if (!result.is_task || !result.tasks || result.tasks.length === 0) {
      if (learnedLines.length > 0) {
        await ctx.reply(learnedLines.join("\n"));
      }
      return; // 不是任务，不回应任务内容，避免打扰
    }

    const confirmLines = [...learnedLines];

    for (const task of result.tasks) {
      if (task.need_clarification) {
        await ctx.reply(`❓ ${task.need_clarification}`);
        continue;
      }

      const id = await addTask({
        date: task.date,
        time: task.time,
        content: task.content,
        project: task.project,
        urgent: task.urgent,
        hard_deadline: task.hard_deadline,
        raw_message: userMessage,
      });

      const dateLabel = task.date ? task.date : "（未定日期）";
      const timeLabel = task.time ? ` ${task.time}` : "";
      const projectLabel = task.project ? `[${task.project}] ` : "";
      const urgentLabel = task.urgent ? " 🔴急" : "";
      confirmLines.push(`✅ ${id} ${dateLabel}${timeLabel} — ${projectLabel}${task.content}${urgentLabel}`);
    }

    if (confirmLines.length > 0) {
      await ctx.reply(confirmLines.join("\n"));
    }
  } catch (err) {
    console.error("处理消息失败:", err);
    await ctx.reply("⚠️ 记录的时候出了点问题，稍后再试一次，或者检查一下log。");
  }
});

// --- /list 查看待处理任务 ---
bot.command("list", async (ctx) => {
  try {
    const sheet = await getTasksSheet();
    const rows = await sheet.getRows();
    const pending = rows.filter((r) => (r.get("状态") || "") === "待处理");

    if (pending.length === 0) {
      await ctx.reply("目前没有待处理的任务 🎉");
      return;
    }

    // 按日期排序（无日期的排最后）
    pending.sort((a, b) => {
      const da = a.get("日期") || "9999-99-99";
      const db = b.get("日期") || "9999-99-99";
      return da.localeCompare(db);
    });

    const lines = pending.map((r) => {
      const id = r.get("任务ID");
      const date = r.get("日期") || "未定日期";
      const time = r.get("时间") ? ` ${r.get("时间")}` : "";
      const project = r.get("关联客户项目") ? `[${r.get("关联客户项目")}] ` : "";
      const content = r.get("内容");
      const urgent = r.get("紧急标记") === "是" ? " 🔴" : "";
      return `${id} | ${date}${time} — ${project}${content}${urgent}`;
    });

    await ctx.reply(`📋 待处理任务（共${pending.length}项）\n\n${lines.join("\n")}`);
  } catch (err) {
    console.error("/list 失败:", err);
    await ctx.reply("⚠️ 读取任务列表失败。");
  }
});

// --- /done [任务ID] ---
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

    row.set("状态", "已完成");
    row.set("完成时间", new Date().toISOString().slice(0, 16).replace("T", " "));
    await row.save();

    await ctx.reply(`✅ ${taskId} 已标记完成`);
  } catch (err) {
    console.error("/done 失败:", err);
    await ctx.reply("⚠️ 标记完成失败。");
  }
});

// --- /cancel [任务ID] ---
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

    await ctx.reply(`🗑️ ${taskId} 已取消`);
  } catch (err) {
    console.error("/cancel 失败:", err);
    await ctx.reply("⚠️ 取消失败。");
  }
});

bot.launch();
console.log("MJ秘书Bot已启动...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
