# MonkeyCode 自动化调度台

面向 Linux VPS 的轻量 MonkeyCode 对话调度器。它使用官网前端同款 WebSocket 协议向现有任务发送消息，并提供完整的中文 Web 管理面板。

## 功能

- 多任务独立启停、发送时间、时区、工作日和自定义星期。
- VPS 为已启用的任务常驻官网 `control` WebSocket，休眠环境会自动唤醒，并持续刷新休眠计时。
- 多 MonkeyCode 账号集中管理，一个账号可关联多个任务，任务之间也可使用不同账号。
- 本地 Chrome 扩展按浏览器配置同步 HttpOnly Cookie，VPS 无需运行本地代理。
- 一次性配对码、每设备独立令牌、账号身份锁和远程吊销。
- 指定日期额外执行或排除，支持 VPS 离线后的当天补跑。
- `{{date}}`、`{{time}}`、`{{weekday}}`、`{{task_name}}` 动态提示词变量。
- 提示词实时预览、最近 20 个版本和一键恢复。
- Cookie 有效性验证、精确到期时间、提前 3 天提醒和登录失效记录。
- 轻量同步账号资料、套餐、每日额度、远端任务、模型用量和开发环境状态。
- 远端任务支持按账号、状态和名称筛选，并可直接选中创建本地定时任务。
- 额度不足、远端任务异常、任务丢失和环境休眠提醒，可独立配置同步周期与阈值。
- 模拟运行、普通发送、强制发送、远端历史与本地状态双重防重复。
- 网络和服务器错误重试；登录失效、配置错误和其他 4xx 错误不重试。
- 通用 Webhook、企业微信、钉钉、Telegram、Bark 和 SMTP 邮件通知。
- 执行日志筛选、CSV 导出、配置导入导出和最近 30 份自动备份。
- 响应式桌面与手机界面。
- 在同一登录会话中管理 Node Pool 节点、资源、项目白名单与部署任务。

Cookie 和通知密钥使用 AES-256-GCM 加密保存。浏览器桥接令牌在 VPS 上只保存 SHA-256 哈希；管理 API 不返回原始密钥，面板写操作使用 HttpOnly 管理会话和 CSRF 校验。

## VPS 部署

要求 Node.js 20 或更高版本、systemd 和一个普通 Linux VPS。

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin monkeycode 2>/dev/null || true
sudo install -d -m 755 /opt/monkeycode-daily
sudo cp -a package.json package-lock.json src web deploy /opt/monkeycode-daily/
cd /opt/monkeycode-daily
sudo npm ci --omit=dev
sudo chown -R root:root /opt/monkeycode-daily
```

生成独立的主密钥和管理密码。主密钥一旦丢失，已有 Cookie 和通知凭证无法解密。

```bash
openssl rand -base64 32
openssl rand -base64 24
sudoedit /etc/monkeycode-panel.env
```

环境文件格式：

```dotenv
MONKEYCODE_PANEL_HOST=127.0.0.1
MONKEYCODE_PANEL_PORT=4180
MONKEYCODE_PANEL_PASSWORD=填写第二条命令生成的管理密码
MONKEYCODE_MASTER_KEY=填写第一条命令生成的32字节主密钥
MONKEYCODE_SECURE_COOKIE=true
MONKEYCODE_BROWSER_BRIDGE_ENABLED=true
```

```bash
sudo chown root:root /etc/monkeycode-panel.env
sudo chmod 600 /etc/monkeycode-panel.env
sudo cp deploy/systemd/monkeycode-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monkeycode-panel.service
sudo systemctl status monkeycode-panel.service
```

旧版一次性 timer 不再需要：

```bash
sudo systemctl disable --now monkeycode-daily.timer 2>/dev/null || true
```

### 访问面板

默认只监听 VPS 的 `127.0.0.1`。仅使用手工 Cookie 时可以通过 SSH 隧道访问：

```bash
ssh -L 4180:127.0.0.1:4180 your-user@your-vps
```

浏览器打开 `http://127.0.0.1:4180`。此方式不需要开放新的公网端口，并将 `MONKEYCODE_SECURE_COOKIE` 改为 `false`。

浏览器扩展长期自动同步时，推荐使用 [Nginx 示例](deploy/nginx/monkeycode-panel.conf) 配置公网域名和有效 HTTPS 证书，并保持 `MONKEYCODE_SECURE_COOKIE=true`。不要直接把 4180 端口暴露到公网。

本地开发和 Docker 部署统一使用被 Git 忽略的 `.env`，变量清单见 [`.env.example`](.env.example)。主密钥必须与数据目录配套，不能提交到 Git。

## Chrome 扩展与多账号

扩展运行在本地电脑，调度台和任务运行在 VPS。两者通过 HTTPS 通信，不需要在本地运行 Node.js。

1. 为每个 MonkeyCode 账号创建独立的 Chrome 配置，并在对应配置中登录 `monkeycode-ai.com`。
2. 在该配置打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，目录为本项目的 [`extension`](extension)。
3. 登录 VPS 调度台，在“账号”中添加远程账号，点击“浏览器同步”并生成一次性配对码。
4. 打开扩展，填写面板 HTTPS 地址、配对码和设备名称。授权后会立即读取 `monkeycode_ai_session`、在 VPS 验证当前用户并加密保存。
5. 其他账号重复以上步骤，每个 Chrome 配置只连接一个远程账号。一个远程账号可以连接多个设备，任一设备都可在面板中单独吊销。

扩展会在 Cookie 变化、Chrome 启动以及每 6 小时检查时同步，并在到期前 3 天发出本地通知。服务端只有在官网 `/api/v1/users/status` 验证成功且用户 ID 与该远程账号一致后才原子替换 Cookie，错误账号不会覆盖原凭证。

扩展不会保存 MonkeyCode 密码、自动填写验证码或绕过登录流程。它也不能主动延长官网会话；Cookie 过期后，需要在对应 Chrome 配置中重新登录，新的 Cookie 会自动同步。

## 首次配置

1. 登录调度台，进入“账号”，创建账号并通过 Chrome 扩展配对；也可以应急手工填写 Cookie Value。
2. 进入“任务”新建任务，填写 MonkeyCode 任务 UUID、提示词并选择发送账号。
3. 保存后先执行“模拟”。
4. 确认无误后关闭“计划仅模拟”，再启用任务。

同一个账号可以供多个任务使用。更新账号 Cookie 后，所有关联任务会立即使用新凭证；仍被任务引用的账号不能删除。旧版配置首次启动时会自动备份，并将每个任务原有的 Cookie 迁移为独立账号。

不要把 Cookie、桥接令牌、主密钥或管理密码发到聊天、提交到 Git 或写入普通脚本。线上站点可以调整会话有效期；扩展读取 Cookie 的实际到期时间，面板会按账号显示并发送提醒。

## 远端账号与任务同步

“账号”页会显示登录状态、套餐、每日额度、远端任务数量和最近同步结果；“远端任务”页集中显示任务名称与 ID、状态、模型、Token 用量、最后活动时间以及开发环境状态。同步后的任务可直接用于新建本地定时任务，无需手工复制 UUID。

后台默认每 10 分钟同步一次，也可以在“设置 → 远端状态同步”中调整周期、关闭自动同步或修改额度告警阈值。元数据同步本身只调用普通 HTTPS 接口；任务启用“持续保持环境”后，VPS 会另行常驻官网任务页使用的 `control` WebSocket。建立连接会唤醒休眠环境，连接期间由平台每分钟刷新休眠计时；面板不会向该通道发送任务消息。

休眠保持和回收续期是两件事。MonkeyCode 当前服务端的 `KeepAwake` 只刷新休眠计划；用户真实输入或环境活动触发的 `RecordActivity` 才会同时刷新休眠、通知和回收计划。因此，想实现无人值守续期，需要同时启用自动调度、关闭“计划仅模拟”，并使用有实际意义且会变化的提示词（默认模板含 `{{date}}`）。控制通道本身不消耗任务输入，但不能承诺环境永不回收。

MonkeyCode 未公开每个任务精确的休眠倒计时和回收截止时间。只有当账号所属团队接口返回有效策略时，面板才显示休眠/回收策略；否则明确显示“平台控制”，不会把 `life_time_seconds=0` 解释成永不过期。账号 Cookie 到期时间来自浏览器实际 Cookie 属性，与开发环境休眠是两套独立状态。

## 调度行为

- 面板每 30 秒检查一次到期任务。
- “错过后补跑”开启时，当天计划时间之后首次上线会补跑一次。
- 定时任务每天只登记一次执行结果；重试在单次执行内部完成。
- 普通发送保留防重复检查，强制发送会跳过防重复并要求二次确认。
- 全局暂停不会删除任务、历史或凭证。
- 通知失败单独写入运行记录，不会撤销已经被 MonkeyCode 接收的消息。

## 数据与备份

默认数据目录为 `/var/lib/monkeycode-panel`：

- `config.json`：账号、任务和通知配置，Cookie 与通知密钥为 AES-256-GCM 密文。
- 浏览器配对信息保存在 `config.json`，只包含设备信息和桥接令牌哈希，不包含令牌明文。
- `runs.jsonl`：执行与通知记录，不包含 Cookie 或完整提示词。
- `schedule-state.json`：当天调度状态。
- `task-state/`：本地防重复状态。
- `backups/`：配置变更前自动保留的最近 30 份备份。

面板导出的备份同样只包含密文。迁移到其他 VPS 时必须使用原来的 `MONKEYCODE_MASTER_KEY`。

## 运维

```bash
systemctl status monkeycode-panel.service
journalctl -u monkeycode-panel.service --since today --no-pager
sudo systemctl restart monkeycode-panel.service
```

面板显示的是 Node 进程实际 RSS 内存。正常常驻通常为几十 MB，并由 systemd 限制在 256 MB；每个任务没有独立常驻进程。

## 兼容命令行

原来的单任务环境变量模式继续保留：

```bash
npm run send
```

其配置示例见 [.env.example](.env.example)，旧的 oneshot service 和 timer 保留在 `deploy/systemd/`，但不能与面板调度同时启用同一个任务。

## Docker 与 GitHub Actions

面板和 Node Pool 控制器镜像只在 GitHub Actions 中构建，并发布到同一个阿里云 ACR 镜像仓库：

```text
crpi-ijf5w3rczq2vwnig.cn-beijing.personal.cr.aliyuncs.com/mufenxu/my
```

面板使用 `latest`、`sha-<提交号>` 和版本号标签；Node Pool 使用 `node-pool-latest`、`node-pool-sha-<提交号>` 和 `node-pool-<版本号>` 标签，两个镜像不会互相覆盖。Pull Request 只执行检查、构建和两个容器的健康检查，不推送镜像。仓库需要配置 GitHub Actions Secret `ALIYUN_ACR_PASSWORD`，值为阿里云容器镜像服务个人版的固定登录密码；登录用户名和镜像地址已经固定在工作流中。密码不会写入代码、日志或镜像。

VPS 在 `compose.yaml` 同目录创建唯一的真实配置文件 `.env`，可直接以 [`.env.example`](.env.example) 为变量清单。至少填写：

```dotenv
MONKEYCODE_PANEL_PASSWORD=填写至少12位的管理密码
MONKEYCODE_MASTER_KEY=填写32字节Base64主密钥
MONKEYCODE_SECURE_COOKIE=true
MONKEYCODE_BROWSER_BRIDGE_ENABLED=true
MK_ADMIN_TOKEN=沿用现有管理令牌
MK_WORKER_SECRET=沿用现有Worker密钥
MONKEYCODE_NODE_POOL_PUBLIC_URL=https://mk.pxyb.cn/node-pool
MK_MANAGEMENT_URL=https://mk.pxyb.cn/#deployments
```

面板和控制器在容器内分别监听 `4180`、`4190`，宿主机只监听 `127.0.0.1`。公网统一使用 `mk.pxyb.cn`：管理页面位于 `/#deployments`，Worker API 和受保护的安装包位于 `/node-pool/`。所有公网请求都进入面板的 4180 端口，面板只把经过路径白名单校验的 Worker 请求转发到控制器；节点池管理 API 和 `MK_ADMIN_TOKEN` 不会暴露到公网。Nginx 无需为 4190 增加第二个反向代理。

首次部署或更新：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 monkeycode-panel
docker compose logs --tail=200 node-pool-controller
```

从旧 systemd 或独立 Compose 控制器迁移时，先保留原密钥和 `state.json`，再导入新的 `node-pool-data` 命名卷。不要用空状态直接覆盖现有控制器。如果阿里云仓库要求登录拉取，请在 VPS 使用相同的 ACR 用户名和固定密码执行 `docker login`。`docker compose down` 不删除命名卷，不能使用 `docker compose down -v`，否则会删除面板和 Node Pool 数据。

## 测试

测试仅访问本机模拟服务，不会向真实 MonkeyCode 任务发送消息：

```bash
npm install
npm test
```

接口实现依据：

- [MonkeyCode 官方前端 Task Stream Client](https://github.com/chaitin/MonkeyCode/blob/main/frontend/src/components/console/task/task-stream-client.ts)
- [MonkeyCode 官方后端任务接口](https://github.com/chaitin/MonkeyCode/blob/main/backend/biz/task/handler/v1/task.go)
- [MonkeyCode 官方会话实现](https://github.com/chaitin/MonkeyCode/blob/main/backend/pkg/session/session.go)
