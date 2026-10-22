# 独立 AWS / GCP 文件与 CDN 工具

本机运行的 S3 文件管理与 CloudFront 缓存失效工具，中文界面。浏览器访问本地 Node.js 服务，由服务端通过 AWS SDK v3 调用 AWS；无需数据库或 AWS CLI。采用 MIT 许可证。

现增加独立的 GCP 页面：Cloud Storage 文件管理与全局外部 Application Load Balancer 的 Cloud CDN 缓存失效。页面顶部点击“GCP 文件与 CDN”，或访问本地地址的 `/gcp`。AWS 与 GCP 使用独立的会话、凭证和任务。GCP 配置与权限说明见 [GCP 使用指南](docs/gcp.md)。
Windows 启动器会尝试自动识别常见的本机 V2Ray/Xray 代理，供 Google Cloud 请求使用。手动通过终端启动时可先设置 `HTTPS_PROXY=http://127.0.0.1:10808`；端口按本机代理配置修改。

## 快速开始

安装 Node.js 22 或更新版本，然后运行：

```sh
git clone https://github.com/llaassmail-ui/aws-storage-tool.git
cd aws-storage-tool
npm ci --ignore-scripts
npm start
```

Windows 也可下载 Release 源码 ZIP，完整解压后双击 `启动工具.bat`，浏览器会自动打开。更新后双击 `重启工具.bat`，确认提示后自动重启并打开页面；无需手动结束进程或输入命令。英文入口 `start.bat`、`restart.bat` 功能相同。重复启动会打开已有服务，脚本会记住上次成功使用的端口。Linux/macOS 使用上述命令启动。运行时需要本机网络能够访问 AWS HTTPS API。GitHub Pages 无法运行本工具的 Node.js 服务端。

重启会中断执行中任务、清空连接和任务记录，请等待任务结束后操作；已提交的 CloudFront 失效不会撤销。启动窗口可关闭，服务在后台运行。首次启动若默认端口被旧版本或其他程序占用，会自动选择空闲端口并记住地址，不会关闭旧服务。后续重启仅针对由此目录启动且身份匹配的服务。启动失败时查看工具目录中的 `tool.stderr.log`。

默认地址为 http://127.0.0.1:8787 ，Windows 启动入口以实际自动打开的地址为准。仅监听 127.0.0.1。高级用法：通过环境变量 `PORT` 指定端口；显式指定的端口被占用时会报错。通过 `npm start` 在终端启动的服务使用 Ctrl+C 停止；更新后重新运行该命令。双击启动的服务使用 `重启工具.bat` 更新。

## 使用

输入 Access Key、Secret Key，以及临时凭证的 Session Token。S3 列桶与 CloudFront 列分配分别验证；其中一个失败不阻止另一个。状态仅证明该读取操作可用，不代表其他写权限。

点击 Bucket 进入目录；区域自动发现失败时，在区域栏输入 AWS 区域并刷新，例如印度孟买 `ap-south-1`、海得拉巴 `ap-south-2`。支持目录导航、当前目录多选及分页加载。

S3 页面可通过资源链接定位。输入 CloudFront 域名链接或 S3 原始链接，点击“定位”，核对候选后“打开 S3 目录”。CloudFront 按 Cache Behavior 配置顺序匹配路径，选择对应源并拼接 OriginPath；根 URL 使用 DefaultRootObject。文件位于后续分页时自动继续查找并高亮，不自动勾选。多分配、故障转移源组会列出候选；非 S3 源明确报错。仅查询配置和浏览 S3，不访问输入链接、不执行写操作。

链接定位额外需要 `cloudfront:GetDistributionConfig`（授权到相应分配）；S3 原始链接无需 CloudFront 权限。路径百分号编码解码一次，查询参数及片段不计入对象键（文件名中的 `#` 应编码为 `%23`）。含点目录或反斜杠的歧义链接拒绝自动解析。函数改写、持续部署、S3 网站索引/重定向会提示推算限制；目录 URL 只定位前缀，不推断子目录索引文档。自定义非 AWS S3 源域名需手动定位。

复制或移动可填任意目标 Bucket 和目录，保留选中项名称与内部层级。默认跳过同名对象，可显式覆盖。文件夹先完整列举源清单，再执行。移动不是原子事务：复制失败不删源，删除源失败会报告目标已复制、源仍保留。删除对版本化桶执行普通删除，不永久删除旧版本。跳过检查使用 HeadObject；没有目标读取权限时会报错，不猜测对象不存在。并发外部写入仍可能产生检查与写入间竞争，请避免其他程序同时修改同一目标。

拖入文件或文件夹，或使用选择入口，确认后上传。最多同时上传三个文件，服务端流式分段上传。进度显示 S3 传输字节，只有 SDK 确认提交成功才显示写入完成。失败清单保留，可重试失败文件。上传一律 `public-read`。复制和移动在对象内容复制成功后，也会显式将目标对象 ACL 设置为 `public-read`；不会读取或继承源对象 ACL。目标桶必须允许对象 ACL，且 Block Public Access 不能禁止公开 ACL。若 Object Ownership 为 `Bucket owner enforced` 或公开 ACL 被阻止，ACL 设置会失败；内容可能已复制到目标，但移动会保留源对象，并报告目标已复制、源仍保留。工具不会修改桶策略或回退为私有对象。空文件夹没有文件内容，不会作为独立上传项。

CloudFront 输入域名或完整 URL，精确匹配优先，随后匹配通配符别名。选择分配后每行填写一个失效路径。确认提交后显示请求 ID，按五秒间隔查询，查询失败保留已提交状态并继续查询。网络重试复用 CallerReference。断开或关闭页面会停止浏览器查询；已提交的 AWS 失效请求无法撤销。

## 权限与安全

参考 [IAM 策略示例](docs/iam-policy.example.json)，先替换 Bucket、账号和分配占位符，再按实际需要删减操作权限。该示例允许指定桶的对象删除及公开 ACL；不应给无关桶授权。列桶、列分配接口需要 `Resource: "*"`，它们会列出账号范围的可见资源。示例不包含 KMS 权限。

常用 IAM 权限包括 `s3:ListAllMyBuckets`、`s3:GetBucketLocation`、`s3:ListBucket`、`s3:GetObject`、`s3:PutObject`、`s3:PutObjectAcl`、`s3:DeleteObject`、`s3:AbortMultipartUpload`，以及复制标签/版本所需的读取权限。复制目标设置 ACL 需要 `s3:PutObjectAcl`，不需要读取源 ACL 的 `s3:GetObjectAcl`。CloudFront 需要 `cloudfront:ListDistributions`、`cloudfront:CreateInvalidation`、`cloudfront:GetInvalidation`。KMS、对象保留、组织 SCP、桶策略等限制以 AWS 实际响应为准。

密钥仅存在本机服务内存，不进入浏览器持久化存储、文件或日志。会话使用 HttpOnly、SameSite=Strict Cookie；接口校验 Host 和 Origin。依赖通过 npm 安装，运行页面不加载外部脚本。服务不适合暴露到公网或共享主机多用户环境。断开会清除该会话凭证并中止未完成工作。直接关页面不会停止服务，应点击断开或停止本地服务。

任务与结果暂存内存，重启清空。批量源清单需占用与对象数量对应的内存；超大目录需留意本机内存。SDK 对可重试错误有限重试，连接超时 10 秒、socket 超时 60 秒；权限错误按原始 AWS 错误展示。失败的 multipart 会尝试清理，清理失败提示需检查未完成分段，建议桶配置清理不完整 multipart 的生命周期规则。

## 验证

任务栏按操作类型、源 Bucket/目录和目标 Bucket/目录合并显示；同一路径多次操作累计到同一行。上传按目标目录合并。点击任务行展开逐项结果，点击“查看失败项”打开独立的失败详情窗口。失败上传重试会更新对应记录。任务栏是当前页面的临时记录，刷新页面后清空。

执行 `npm test` 运行不连接真实 AWS 的回归测试，包括域名/路径、分页、递归目标、复制失败不删源、取消、部分失败、会话保护、独立权限检查和 ACL 拒绝。真实 AWS 测试需要用户自己的测试凭证。上传、移动、删除、失效仅应在明确授权的测试资源执行；模拟测试不能证明实际账户的 IAM、CORS 之外的网络配置、KMS 和桶公开访问设置可用。

## 问题排查与贡献

- `connect EACCES`、超时或网络连接失败：先检查本机防火墙和 AWS 网络可达性；此类错误不等于 IAM 拒绝。
- `AccessDenied`：检查 IAM、Bucket 策略、组织策略和目标路径权限。
- `AccessControlListNotSupported`：目标桶禁用了对象 ACL，无法完成此工具要求的公共读操作。
- `本地接口不存在`：更新后重启 Node.js 服务并刷新页面。

欢迎提交 Issue 和 Pull Request。提交前运行 `npm test`。请使用虚构 Bucket 和域名复现问题，勿在 Issue、日志或截图中粘贴密钥、Session Token 或真实业务数据。依赖保留各自许可证；仓库中的 MIT 许可证适用于本工具源码。
