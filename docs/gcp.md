# GCP 文件与 Cloud CDN

## 环境与连接

若浏览器能访问 Google、而工具报 `ETIMEDOUT`，通常是浏览器通过 V2Ray/Xray 代理、Node.js 服务却没有继承代理。Windows 启动器会自动检测常见本地代理端口；手动启动时，可在同一终端先设置 `HTTPS_PROXY=http://127.0.0.1:10808`（端口按本机配置修改）。工具只读取代理环境变量，不读取或保存 V2Ray 配置。

沿用 Node.js 22+ 和本机 HTTP 服务，无需单独部署。更新代码后先运行 `npm ci --ignore-scripts`，再重启工具。Windows 启动器发现缺少 GCP 依赖会自动安装。运行时需要访问 Google OAuth、Resource Manager、Cloud Storage 和 Compute HTTPS API。网络连接失败不等于 IAM 权限不足。

点击顶部 GCP 入口，选择一种认证方式：

- **本机 ADC**：提前安装 Google Cloud CLI，在本机运行 `gcloud auth application-default login`。普通的 `gcloud auth login` 不等同于配置 ADC。服务端使用 Google 官方认证库读取本机 ADC；不将 ADC 内容传给网页。
- **服务账号 JSON**：选择 Google 下载的 `type: service_account` JSON 文件，确认连接后发送给本机服务。工具不保存上传的凭证文件，不写入日志或浏览器持久存储；断开连接清除本工具会话内的凭证。原始文件和 CLI 已保存的 ADC 不会由本工具删除。

登录后尝试列出可访问项目。列项目被拒绝时可以手动输入 Project ID。选择项目分别检查列桶和列全局 URL Map 权限，一项失败不阻塞另一项。这些检查只代表实际读取接口可用，不代表拥有写入、删除或失效权限。

## Cloud Storage

按桶和目录浏览、分页加载，支持新建文件夹、递归复制、移动、删除以及文件/文件夹拖放上传。文件夹采用对象名前缀和零字节标记显示；空文件夹拖放不会产生文件上传。

上传、复制和移动时必须明确选择权限：

- **继承桶权限**：不主动添加公共读 ACL。是否公开由桶的 IAM 和默认对象权限决定，不能将这个选项理解为“强制私有”。
- **公共读**：请求对象 `publicRead` 权限。统一桶级访问（UBLA）、禁止公开访问（Public Access Prevention）或组织策略可能拒绝此操作。工具不会修改桶 IAM、禁用这些保护，也不会静默改为私有写入。启用了 UBLA 的桶应选择继承桶权限；是否已公开由管理员的桶 IAM 决定。

同名对象默认跳过，覆盖必须显式确认。上传采用流式可恢复上传，最多同时传输三个文件，完成状态以 Cloud Storage 确认写入为准。失败文件保留在当前页面，可仅重试失败文件；刷新页面后需要重新选择本地文件。

复制先固定源对象清单，使用 rewrite token 处理大对象，并通过 generation 条件保护源和目标。移动逐个对象执行复制后删除，删除绑定原 generation；复制失败不会删除源，删除失败会显示“目标已复制，源仍保留”。这不是原子操作。工具不会清除桶的历史版本或批量清理回收站；版本、软删除、保留策略、KMS 限制按实际桶配置与 API 结果处理。

## Cloud CDN

输入域名或完整 URL，搜索当前项目的全局 URL Map，按 hostRules 精确匹配优先，再显示通配符候选。多个候选需要选择。URL Map 匹配并不能证明公网 DNS 正在指向该负载均衡器，也不能证明所有后端都启用了 Cloud CDN，请核对所选资源。第一版不支持区域 URL Map 或 Media CDN。

可从 URL 提取 Host 和路径，也可手动填写。每行一条失效路径，去重后提交；路径以 `/` 开头，`*` 仅允许在末尾，不接受查询参数或片段。`/*` 会清理指定 Host 下的全部路径，提交前再次确认。

多条路径分别提交，每条使用稳定的 requestId 并显示 Operation ID。每条请求的提交失败、已提交、完成和执行失败分别记录。查询失败不会把已提交请求标为提交失败；达到轮询上限后可以继续查询。停止任务只会停止后续提交与本机查询，已经提交到 Google 的失效无法撤销。

任务保存在本机服务的会话内存中，刷新 GCP 页面可重新获取进度与结果。服务重启或主动断开会清空记录。重启前请等待文件操作结束。

## 权限参考

按实际项目和桶分配最小权限；下列是功能与权限的对应关系，并非要求授予项目 Owner：

| 功能 | 常见所需权限 |
| --- | --- |
| 自动发现项目 | `resourcemanager.projects.get`（搜索仅返回有此权限的项目） |
| 列出项目存储桶 | `storage.buckets.list` |
| 浏览和读取对象 | `storage.objects.list`、`storage.objects.get` |
| 上传、创建文件夹、复制目标 | `storage.objects.create`；覆盖另需 `storage.objects.delete` |
| 移动源、删除 | `storage.objects.delete` |
| 设置对象公开 ACL | `storage.objects.setIamPolicy`；源/目标策略仍须允许 |
| 查找 CDN 配置 | `compute.urlMaps.list` |
| 提交失效 | `compute.urlMaps.invalidateCache` |
| 查询失效进度 | `compute.globalOperations.get` |

需要在相应项目启用 Compute Engine API、Cloud Storage API；自动发现项目使用 Cloud Resource Manager API。ADC 的配额项目可能还需要 `serviceusage.services.use`。跨桶操作须同时具备源与目标权限；使用 CMEK 时另需对应 KMS 权限。实际错误保留操作、对象、错误码和说明。

## 验证与参考

`npm test` 使用模拟 Google 响应验证会话、分页、版本条件、部分失败和失效状态，不会调用真实云资源。真实账户连通性、IAM、公开访问设置和 LB 配置需使用自己的测试凭证和明确的测试资源验证。

- [ADC 本地开发认证](https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)
- [Cloud Storage 对象 rewrite](https://cloud.google.com/storage/docs/json_api/v1/objects/rewrite)
- [URL Map 缓存失效](https://cloud.google.com/compute/docs/reference/rest/v1/urlMaps/invalidateCache)
- [统一桶级访问](https://cloud.google.com/storage/docs/uniform-bucket-level-access)
