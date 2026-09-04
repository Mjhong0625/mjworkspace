# MJ秘书 Bot — 第一阶段

## 功能
- 私聊发消息，自动判断是否为任务，抓取日期/时间/客户/紧急度，写入Google Sheets的Tasks表
- 信息不完整会追问
- 一条消息可拆出多个任务
- `/list` 查看待处理任务
- `/done T0001` 标记完成
- `/cancel T0001` 取消任务
- 只回应你自己的Telegram账号，其他人发消息不理

## 本地测试

```bash
npm install
cp .env.example .env
# 填好 .env 里的值
node bot.js
```

## Railway 部署步骤

1. 在Railway新建一个Service（跟Josephy bot的project分开）
2. 把这个文件夹上传/连接到该Service（可以用GitHub repo，或直接上传代码）
3. Railway → Variables，逐一加入以下环境变量：

   | 变量名 | 说明 |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | BotFather给的Token |
   | `ANTHROPIC_API_KEY` | Claude API Key |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 服务账号json里的 `client_email` |
   | `GOOGLE_PRIVATE_KEY` | 服务账号json里的 `private_key`（整段贴上，含 `-----BEGIN PRIVATE KEY-----`） |
   | `GOOGLE_SHEET_ID` | Google Sheets网址中 `/d/` 和 `/edit` 之间那段ID |
   | `OWNER_TELEGRAM_ID` | 你的Telegram数字ID（用 @userinfobot 查） |

   ⚠️ 注意：Railway Variables有缓存bug，如果之后要**修改**某个已存在的变量值，改了可能不生效，建议新增一个变量名（比如加`_V2`后缀）代替旧的，这是从Josephy项目踩过的坑学到的经验。

4. Start Command设为 `node bot.js`（或用package.json里的 `npm start`）
5. 部署后在Railway Logs确认看到 `MJ秘书Bot已启动...`
6. Telegram搜你的bot，发送 `/start` 测试

## Google Sheets 准备

- 用你已经建好的表格（依照「个人秘书Bot_数据模板.xlsx」的分页名与栏位）
- 记得把服务账号的 `client_email` 加入该表格的「共享」名单，给「编辑者」权限，否则Bot读写会失败

## 之后阶段（尚未包含在这版代码里）
- 每日提醒 / 未完成升级提醒（node-cron）
- 主动侦测沉默项目
- 每周总结
- 实体库自动累积
