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
  return getSheet("Tasks", [
    "任务ID", "日期", "时间", "内容", "关联客户项目", "紧急标记",
    "类型", "状态", "已提醒次数", "原始消息", "创建时间", "完成时间",
  ]);
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
    内容: task.content || "",
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

module.exports = {
  getDoc,
  getTasksSheet,
  addTask,
  getEntitiesSheet,
  loadEntities,
  getConfigSheet,
  loadConfig,
};
