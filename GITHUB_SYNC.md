# 《解放战争》项目同步到 GitHub

## 目标仓库（英文仓库名，GitHub 账号根级）

- Owner：`list01`
- Repository：`liberation-war-command-sim`
- URL：`https://github.com/list01/liberation-war-command-sim`
- 可见性：Public
- 本地 `origin` 已按上述英文仓库名配置好；分支为 `main`。

## 当前状态（已在本机完成）

| 项 | 值 |
|---|---|
| 本地仓库 | `D:/Workspace/projects/liberation-war-command-sim` |
| 分支 | `main` |
| 初始提交 | `991535f 初始提交：《解放战争》师级指挥模拟器 v1.4.1` |
| 最新提交 | `a73283a docs: 添加 GitHub 同步指南与 PAT 辅助脚本` |
| 纳入版本控制 | 15 个文件，约 1.1 MB |
| 敏感文件扫描 | 未发现 `.env` / 密钥 / 令牌 / 证书 |
| 工作树 | 干净 |

项目源码位于**仓库根目录**：`src/`、`docs/`、`data/`、`tests/`、`tools/`、`README.md`、`.gitignore` 都在根下，无需额外子目录。

已纳入：`README.md`、`.gitignore`、`src/`（主游戏 + 地理对照页）、`docs/`（DESIGN / SOURCES）、`data/`（ASTER 高程数据与采集脚本）、`tests/`、`tools/`、`out/.gitkeep`。

已排除：`.workbuddy/`（含本机路径的元数据）、`out/*`（生成物）、`deploy/`（上次中断的阿里云部署暂存，非源码）。

## 同步方式：REST API（不走 git push）

本机代理环境禁用了 `git push` 协议，因此采用 GitHub REST API 同步。**不要两种方式混用**，否则本地 git 与远端会分叉；API 生成的 commit SHA 与本地提交必然不同，**以远端为权威**。

### 推荐方式：API 一键同步（脚本）

```powershell
# 1) 独立生成 PAT（仓库读写最小权限），只放环境变量，不写入文件
$env:GITHUB_TOKEN = "你的独立生成令牌"
# 2) 执行（Python 标准库，零第三方依赖）
python tools/sync_github_api.py
```

bash 写法：

```bash
GITHUB_TOKEN="你的独立生成令牌" python tools/sync_github_api.py
```

脚本行为：

- 仅在账号根级创建/复用英文仓库 `list01/liberation-war-command-sim`；
- 递归收集**仓库根目录**源码（16 个文件），排除 `.git`、`.workbuddy/`、`deploy/`、`out/*`、`__pycache__/`、`.env*`、`*.pem/key/tmp/log`；
- 文本统一 `CRLF → LF`，避免 Windows `core.autocrlf` 误报；二进制 / 中文按 base64；
- 流程严格为 `POST /git/blobs` → `POST /git/trees`（带 `base_tree` 增量）→ `POST /git/commits` → `PATCH/POST refs`；
- 凭证只从 `GITHUB_TOKEN` 读取，不读取聊天 / jsonl / `.env`，也不写入任何文件；
- 不推送 git，本地 `main` 仅作源码快照。

### 单文件更新（文档 / 部署页常用）

```bash
# 取现有 sha（新增文件跳过）
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/list01/liberation-war-command-sim/contents/{path}?ref=main"
# 提交：content 为 base64，更新带 sha、新增不带
curl -s -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"...","content":"<base64>","branch":"main","sha":"<上一步sha>"}' \
  "https://api.github.com/repos/list01/liberation-war-command-sim/contents/{path}"
# HTTP 200=更新，201=新增
```

### 验收（连上后立刻跑）

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/list01/liberation-war-command-sim/commits/main
```

能列出提交即认证与仓库都正常。

## 建议的仓库信息

- 名称：`liberation-war-command-sim`
- 所有者：`list01`（依据同机 `D:/posci` 的 GitHub remote 推断）
- 可见性：Public
- 描述：`《解放战争》师级指挥模拟器：基于真实电文与地理的网页兵棋 v1.4.1`
- 默认分支：`main`（本地已就绪）

## 同步后验证（REST API，不再用 git）

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/list01/liberation-war-command-sim/commits/main
```

再打开 `https://github.com/list01/liberation-war-command-sim`，确认 `src/index.html`、`README.md`、`docs/` 等 16 个文件位于**仓库根目录**。

## 为什么不直接由助手执行

本轮 GitHub 连接器授权被跳过，本机 `GITHUB_TOKEN` / `GH_TOKEN` / `GH_PAT` 均为空；按你的认证原则，助手不从聊天记录、jsonl 日志或 `.env` 捞现成令牌，令牌须独立生成、独立授权。因此远端仓库创建与同步尚未执行。本地侧已就绪：英文仓库名、账号根级 remote、`main` 分支、忽略规则、敏感扫描、API 同步脚本均已完成。

> 附：阿里云 ECS 隧道已按最小清单验收通过（`TUNNEL_OK`、nginx active），但本项目本轮未做服务器部署；GitHub 与服务器操作保持项目边界分离。
