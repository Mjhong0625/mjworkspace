const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

let doc = null;

async function getDoc() {
  if (doc) return doc;

  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

async function getSheet(title, headers) {
  const d = await getDoc();
  let sheet = d.sheetsByTitle[title];
  if (!sheet) {
    sheet = await d.addSheet({ title, headerValues: headers });
  }
  return sheet;
}

// --- Tasks ---
async function getTasksSheet() {
  const sheet = await getSheet("Tasks", [
    "任务ID", "日期", "时间", "内容", "关联客户项目", "紧急标记",
    "类型", "状态", "已提醒次数", "原始消息", "创建时间", "完成时间",
  ]);

  // 自动补栏位：如果表格是旧版本，缺栏位就补加在最后，不影响既有资料
  await sheet.loadHeaderRow();
  const missing = ["标题", "备注", "上次提醒时间"].filter((h) => !sheet.headerValues.includes(h));
  if (missing.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
  }

  return sheet;
}

async function nextTaskId() {
  const sheet = await getTasksSheet();
  const rows = await sheet.getRows();
  const nums = rows
    .map((r) => (r.get("任务ID") || ""))
    .map((id) => parseInt(id.replace(/\D/g, ""), 10))
    .filter((n) => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `T${String(max + 1).padStart(4, "0")}`;
}

async function addTask(task) {
  const sheet = await getTasksSheet();
  const id = await nextTaskId();
  const now = new Date();
  const createdAt = now.toISOString().slice(0, 16).replace("T", " ");

  await sheet.addRow({
    任务ID: id,
    日期: task.date || "",
    时间: task.time || "",
    标题: task.title || task.content || "",
    内容: task.detail || task.content || "",
    关联客户项目: task.project || "",
    紧急标记: task.urgent ? "是" : "否",
    类型: task.hard_deadline ? "硬deadline" : "软提醒",
    状态: "待处理",
    已提醒次数: 0,
    原始消息: task.raw_message || "",
    创建时间: createdAt,
    完成时间: "",
  });

  return id;
}

// --- Entities ---
async function getEntitiesSheet() {
  return getSheet("Entities", ["实体名称", "归属客户项目", "别名（用逗号分隔）"]);
}

async function loadEntities() {
  const sheet = await getEntitiesSheet();
  const rows = await sheet.getRows();
  return rows
    .map((r) => ({
      name: (r.get("实体名称") || "").trim(),
      project: (r.get("归属客户项目") || "").trim(),
      aliases: (r.get("别名（用逗号分隔）") || "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    }))
    .filter((e) => e.name);
}

// --- Config ---
async function getConfigSheet() {
  return getSheet("Config", ["参数名称", "数值", "说明"]);
}

async function loadConfig() {
  const sheet = await getConfigSheet();
  const rows = await sheet.getRows();
  const config = {};
  for (const r of rows) {
    const key = (r.get("参数名称") || "").trim();
    const value = (r.get("数值") || "").trim();
    if (key) config[key] = value;
  }
  return config;
}

async function addEntity(name, project) {
  const sheet = await getEntitiesSheet();
  const rows = await sheet.getRows();
  const exists = rows.some(
    (r) => (r.get("实体名称") || "").trim().toLowerCase() === name.trim().toLowerCase()
  );
  if (exists) return false;

  await sheet.addRow({
    实体名称: name.trim(),
    归属客户项目: project.trim(),
    "别名（用逗号分隔）": "",
  });
  return true;
}

// 从任意文字中抓出可能的任务ID（不管写"008"、"0008"、"T0008"都能辨识），找不到回传null
function normalizeTaskId(text) {
  if (!text) return null;
  const match = String(text).match(/t?0*(\d{1,4})\b/i);
  if (!match) return null;
  return `T${match[1].padStart(4, "0")}`;
}

async function getRowById(id) {
  const sheet = await getTasksSheet();
  const rows = await sheet.getRows();
  return rows.find((r) => (r.get("任务ID") || "").toUpperCase() === id.toUpperCase()) || null;
}

async function updateTaskFields(row, fields) {
  if (fields.title) row.set("标题", fields.title);
  if (fields.detail) row.set("内容", fields.detail);
  if (fields.date) row.set("日期", fields.date);
  if (fields.time !== undefined && fields.time !== null && fields.time !== "") row.set("时间", fields.time);
  if (fields.project) row.set("关联客户项目", fields.project);
  await row.save();
}

async function cancelRowsWithNote(rows, note) {
  for (const row of rows) {
    row.set("状态", "取消");
    const existingNote = row.get("备注") || "";
    row.set("备注", existingNote ? `${existingNote}；${note}` : note);
    await row.save();
  }
}

async function findPendingTasksByKeyword(keyword) {
  const sheet = await getTasksSheet();
  const rows = await sheet.getRows();
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];

  // 先用更聪明的ID辨识，不管"008"、"0008"、"T0008"都能抓出来精准比对
  const normalizedId = normalizeTaskId(kw);
  if (normalizedId) {
    const exact = rows.filter(
      (r) => (r.get("状态") || "") === "待处理" && (r.get("任务ID") || "").toUpperCase() === normalizedId
    );
    if (exact.length > 0) return exact;
  }

  const parts = kw.split(/\s+/).filter(Boolean);
  const pending = rows.filter((r) => (r.get("状态") || "") === "待处理");

  const scored = pending.map((r) => {
    const haystack = `${r.get("任务ID") || ""} ${r.get("标题") || ""} ${r.get("内容") || ""} ${r.get("关联客户项目") || ""} ${r.get("原始消息") || ""}`.toLowerCase();
    const hits = parts.filter((part) => haystack.includes(part)).length;
    return { row: r, hits };
  });

  // 至少命中一半的关键词（无条件进位），且至少命中1个
  const threshold = Math.max(1, Math.ceil(parts.length / 2));
  const matched = scored.filter((s) => s.hits >= threshold);

  if (matched.length === 0) return [];

  // 命中数最高的排前面，只取命中数等于最高分的那些，避免太多模糊匹配
  const maxHits = Math.max(...matched.map((s) => s.hits));
  return matched.filter((s) => s.hits === maxHits).map((s) => s.row);
}

async function markTaskDoneByRow(row) {
  row.set("状态", "已完成");
  row.set("完成时间", new Date().toISOString().slice(0, 16).replace("T", " "));
  await row.save();
}

async function getAllPendingTasks() {
  const sheet = await getTasksSheet();
  const rows = await sheet.getRows();
  return rows.filter((r) => (r.get("状态") || "") === "待处理");
}

// 找出已经逾期、还没完成的硬deadline任务（用来做升级提醒）
async function getOverdueHardDeadlineTasks() {
  const pending = await getAllPendingTasks();
  const now = new Date();

  return pending.filter((r) => {
    if ((r.get("类型") || "") !== "硬deadline") return false;
    const date = r.get("日期") || "";
    if (!date) return false;
    const time = r.get("时间") || "23:59";
    const deadline = new Date(`${date}T${time}:00+08:00`); // 马来西亚时区
    return deadline.getTime() < now.getTime();
  });
}

async function bumpReminder(row) {
  const current = parseInt(row.get("已提醒次数") || "0", 10) || 0;
  row.set("已提醒次数", current + 1);
  row.set("上次提醒时间", new Date().toISOString()); // 存完整UTC时间戳，避免时区混淆
  await row.save();
}

// 判断这个任务距离上次提醒是否已经超过间隔小时数（第一次提醒必定放行）
function shouldRemindAgain(row, intervalHours) {
  const last = row.get("上次提醒时间");
  if (!last) return true;
  const lastTime = new Date(last);
  if (isNaN(lastTime.getTime())) return true; // 解析失败就放行，避免卡死不提醒
  const hoursSince = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);
  return hoursSince >= intervalHours;
}

module.exports = {
  getDoc,
  getTasksSheet,
  addTask,
  getEntitiesSheet,
  loadEntities,
  addEntity,
  getConfigSheet,
  loadConfig,
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
};
