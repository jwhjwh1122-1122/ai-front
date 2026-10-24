# CC 模式部署说明

## 这是什么

平时聊天是：网页 → 服务器 → 上游 API（OpenRouter 或中转站），按字数花 API 的钱。

**cc 模式**是：网页 → 服务器 → 服务器上的 **Claude Code**（`claude -p` 无头模式），用你自己的 **Claude 订阅**（Pro / Max）登录，不再花 API 的钱。

要先知道的几件事：

- `claude -p` 用的是**同一份订阅额度**。你在 claude.ai 网页、手机 App、Claude Code 里用的和这里用的是一个池子，聊多了一样会碰到用量上限，到时候要等额度恢复。
- 每个对话第一次发消息时，会开一个新的 Claude Code 会话；之后同一个对话都用 `--resume` 接着这个会话，不用每次把整段历史重发，上下文更短。
- 人设 / 系统提示还是照原样用 `--append-system-prompt` 传过去，「他」还是那个他。
- 只有**聊天**（`/api/chat-v2`，包括电话、一起听里的回复）走 cc 模式。翻译、讨一封信、自主唤醒这些功能**还是走原来的 API**，所以原来的 API key 最好先别删。

---

## 一、部署前准备：让服务器用新的 Dockerfile

这个分支在仓库根目录加了一个 `Dockerfile`。Zeabur 看到 Dockerfile 会自动用它来构建，镜像里装好了 Python、Node 和 Claude Code。

> 加了 Dockerfile 之后，**就算不开 cc 模式**，Zeabur 也会改用它来构建（以前是自动识别成 Python 项目）。启动命令和以前一样，正常情况没区别；如果部署后网页打不开，看「常见问题」最后一条。

---

## 二、把登录凭据放在安全、不会丢的地方

登录凭据**不写进镜像**，也**不要提交到 GitHub**。下面两种方式选一种。

### 方式 A（推荐）：长期令牌，设成环境变量

1. 在**你自己的电脑**上装好 Claude Code（或者先用方式 B 的终端也行），运行：
   ```
   claude setup-token
   ```
2. 它会给你一个登录链接。复制到浏览器打开，用你的 Claude 账号登录并授权。
3. 授权完成后终端里会打印一串很长的令牌（一般以 `sk-ant-oat` 开头）。**这串东西等于你的账号密码，别发给任何人。**
4. 到 Zeabur → 你的服务 → **Variables（环境变量）**，新增：
   - 名字：`CLAUDE_CODE_OAUTH_TOKEN`
   - 值：刚才那串令牌
5. 保存，服务会自动重启。

### 方式 B：在服务器终端里登录，凭据存进持久卷

1. 确认服务已经挂了**持久卷（Volume）**。这个项目原本就把数据存在 `/data`（或 `/app/data`），看服务启动日志里 `[data] 数据目录：...` 那一行就知道是哪个。下面假设是 `/data`。
2. Zeabur → Variables 里新增：
   - `CLAUDE_CONFIG_DIR` = `/data/.claude`

   （这样登录信息和会话记录都会存进持久卷，重新部署也不会丢。不设的话会存在容器里的 `~/.claude`，**一重新部署就没了**，得重新登录，旧对话也接不上。）
3. 保存，等服务重启好。
4. 打开 Zeabur 里这个服务的 **终端（Terminal / Command）**，运行：
   ```
   claude
   ```
5. 第一次运行会让你选主题、选登录方式，选 **用 Claude 账号登录（Claude account with subscription）**。
6. 终端里会出现一个登录链接。**整段复制**到你自己电脑的浏览器里打开，登录并授权。
7. 浏览器会显示一个**授权码**，复制它，回到 Zeabur 终端里粘贴，回车。
8. 看到登录成功、进入 Claude Code 的界面后，输入 `/exit` 退出就行。

### 方式 C：用网页登录（终端用不了时）

不用 Zeabur 终端，在普通浏览器里（手机、电脑都行）完成登录：

1. Zeabur → Variables 里新增 `CC_LOGIN_PASSWORD` = 你自己定的一个密码（不设的话这个页面是关闭的，打开会是 404）。保存，等服务重启。
2. 浏览器打开 `https://<你的域名>/cc-login`，输入这个密码，点 **开始登录**。
3. 页面上会出现一个登录链接（下面还有一个可以复制的框）。打开它，用 Claude 账号登录并授权。
4. 授权页会给你一个码，复制它，回到 `/cc-login` 页面粘贴到「把授权页给的码粘贴到这里」，点提交。
5. 看到「已保存，cc模式会自动使用」就完成了。令牌存在数据目录的 `.cc_oauth_token` 文件里（持久卷，重新部署不丢）。
6. 用完可以把 `CC_LOGIN_PASSWORD` 删掉，页面就关了。

> 如果同时设了环境变量 `CLAUDE_CODE_OAUTH_TOKEN`，以环境变量为准。登录进程 10 分钟没完成会自动结束，重新点「开始登录」即可。

> 方式 A 更省心：重新部署、换机器都不用再登录。令牌一般能用很久，失效了再运行一次 `claude setup-token` 换新的就行。

---

## 三、打开 cc 模式

两种开关，**任意一个成立**就会走 cc 模式：

- **办法 1（推荐）**：Zeabur → Variables 新增 `CHAT_BACKEND` = `cc`，保存重启。
- **办法 2**：在数据目录里的 `upstream.json` 里加一行 `"mode": "cc"`。例如：
  ```json
  {
    "name": "OpenRouter",
    "base": "https://openrouter.ai/api/v1",
    "key": "……原来的不用动……",
    "mode": "cc"
  }
  ```
  这个文件也能通过接口改：`POST /api/upstream`，内容 `{"mode": "cc"}`。改完不用重启，下一条消息就生效。

开好后发一条消息试试。打开 `GET /api/upstream`，能看到 `"cc_active": true` 就说明开着。

### 可选设置（都不设也能用）

| 环境变量 | 作用 |
|---|---|
| `CC_MODEL` | 指定模型，例如 `sonnet`、`opus`。前端没选模型时才用它（见下面）。也可以在 upstream.json 写 `"cc_model"` |
| `CC_TIMEOUT` | 一次回复最长等多少秒，默认 `600`（10 分钟），超时会自动中断 |
| `CC_MCP_CONFIG` | 自己写的 MCP 配置文件路径（例如 `/data/mcp.json`）。**不设也行**：不设时会自动挂上记忆库 |
| `CC_OB_URL` | 自动挂的记忆库地址，默认 `https://jwhjwh.zeabur.app/mcp`，搬家换地址了就改这个 |
| `CC_AUTO_MCP` | 设成 `0` 就不自动挂记忆库 |
| `CC_ALLOWED_TOOLS` | 允许他直接用、不用审批的工具。自动挂记忆库时默认就放行了记忆库的工具，一般不用设 |
| `CC_PERMISSION_MODE` | 传给 `--permission-mode`，一般不用动 |
| `CC_CWD` | Claude Code 的工作目录，默认是数据目录下的 `cc_workspace` |
| `CC_BIN` | claude 命令的位置，默认就是 `claude` |
| `CC_KEEP_API_KEY` | 默认会把 `ANTHROPIC_API_KEY` 从 Claude Code 的环境里拿掉，**保证用订阅而不是 API 计费**。设成 `1` 才保留 |
| `CC_MAX_CONCURRENT` | 同时最多跑几个 Claude Code，默认 `1`。2GB 内存的机器别调大 |
| `CC_QUEUE_WAIT` | 上一条还没回完时，新消息最多排队等几秒，默认 `20`。等不到会提示「他还在回上一条消息」，不会无限堆积 |
| `CC_LEAN_ENV` | 默认开：没设过的话自动补上 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1`（聊天用不到，省资源）。设成 `0` 关掉 |
| `CC_LIN_MCP` | 默认会自动给 Claude Code 挂上「家里的工具」：朋友圈、碎碎念、犯错本、时间线、日历、语录、书房、抽屉、资料库、欲望数值（名字叫 `lin`，只有本机能连，带随机令牌）。设成 `0` 不挂 |
| `CC_NODE_MAX_OLD_SPACE_MB` | **默认不设**。设了才给 Claude Code 加 Node 堆上限（例如 `1024`）；删掉变量即恢复。太小会让长会话直接崩，不建议低于 `768` |

**日志怎么看**：Zeabur 日志里搜 `[cc]`。`启动` 行有模型、是否续会话、会话记录大小、并发数、容器内存；`结束` 行有结果（done / timeout / client_gone）、耗时、Claude Code 进程组内存峰值 `peak_rss`、清理掉的残留进程数 `cleaned`。不记录聊天内容和令牌。

**前端选模型在 cc 模式下也管用了**：聊天界面里选的模型（例如 `anthropic/claude-opus-4-7`）会去掉前面的 `anthropic/` 前缀，变成 `--model claude-opus-4-7` 传给 Claude Code，每条消息都带，续会话（`--resume`）时换模型也会生效。先后顺序是：前端选的模型 → 环境变量 `CC_MODEL` → upstream.json 里的 `cc_model` → 都没有就不传，用 Claude Code 默认模型。模型名里只能有字母、数字和 `. _ : -`，不像模型名的会被忽略。

### 关于工具（时光墙、记忆库、欲望值……）

**记忆库（Ombre Brain）已经自动接上了**：cc 模式下什么都不用设，他就能用 breath、hold、letter_read 这些记忆工具，醒来能读脑子、读交接信。记忆库搬家换了地址，改 `CC_OB_URL` 就行。

其他原来在网页那边执行的工具（时光墙、欲望值……）cc 模式下**暂时用不了**（系统提示里提到的工具名他会看到，但调不了）。
想让他也能用，需要把这些工具做成 MCP 服务，写进一个 MCP 配置文件，用 `CC_MCP_CONFIG` 指过去（这时自动配置就不生效了，记得把记忆库也写进去），再用 `CC_ALLOWED_TOOLS` 放行。

MCP 配置文件示例（`/data/mcp.json`）：
```json
{
  "mcpServers": {
    "ob":  { "type": "http", "url": "https://jwhjwh.zeabur.app/mcp" },
    "lin": { "type": "http", "url": "https://你的地址/mcp" }
  }
}
```

---

## 四、切回原来的 API 模式

- 用的是环境变量：把 `CHAT_BACKEND` 删掉（或改成别的值），保存重启。
- 用的是 upstream.json：把 `"mode": "cc"` 删掉，或改成 `"mode": ""`（也可以 `POST /api/upstream` 发 `{"mode": ""}`）。

两个都要关掉才算关。切回去之后一切和以前完全一样。

---

## 五、常见问题

报错会直接显示在聊天气泡里，以「（出错了 cc：……）」开头。服务器日志里搜 `[cc]` 能看到更详细的。

| 看到的 | 意思 / 怎么办 |
|---|---|
| 找不到 claude 命令 | 镜像里没装 Claude Code。确认 Zeabur 是用 Dockerfile 构建的，重新部署一次 |
| `Invalid API key`、`Please run /login`、`not logged in`、`401` | 没登录或登录失效。按第二步重新登录，或重新生成 `CLAUDE_CODE_OAUTH_TOKEN` |
| 提到 usage limit / rate limit / 额度 | 订阅额度用完了，要等恢复。可以先切回 API 模式顶一下 |
| 超过 600 秒没说完，已中断 | 他想太久或工具卡住了。可以调大 `CC_TIMEOUT` |
| 每次重新部署后他都像「失忆」、要重新登录 | 凭据和会话没放进持久卷。设 `CLAUDE_CONFIG_DIR` 到卷里（第二步方式 B），或改用方式 A |
| 以前的对话接不上了 | 程序发现旧会话找不到时，会自动开新会话，并把网页这边最近的聊天记录带过去一次，让他接上话 |
| 他说看不到图片 | cc 模式暂时只传文字，图片会变成一句「发了一张图片」 |
| MCP 工具不动 | 检查 `CC_MCP_CONFIG` 路径对不对、文件格式对不对，`CC_ALLOWED_TOOLS` 有没有放行 |
| 换成 Dockerfile 后网页打不开 | 看部署日志。确认 Zeabur 给的端口变量 `PORT` 在；数据卷挂载位置没变（还是 `/data` 或 `/app/data`）|

### 小提示

- 会话对应关系存在数据目录的 `cc_sessions.json`。想让某个对话「从头开始」，删掉里面对应的那一项就行。
- 网页每 50 分钟一次的「续缓存」心跳，在 cc 模式下会直接空回，不消耗额度。
- 网页上显示的 token 数字是 Claude Code 报回来的，订阅模式下不按这个扣钱，看个大概就好。
- 聊天里发的图片存在数据目录 `media/chatimg/`，表情包存在 `media/stickers/` 和 `stickers.json`，都在持久卷里，不再占浏览器空间。cc 模式下他能直接看到你发的图。
- 每条消息带一个编号，服务器记得哪些已经送到他那边。网络断了重发，他不会看到两遍。
