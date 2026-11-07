## 实现

- [x] 1. 在请求摘要与参数入口上先修改 studio-formatters 与 site-branding 单元测试，确认新行为失败。
- [x] 2. 移除请求摘要中的 IP 行与灯箱参数中的 IP 条目；同步 `public/lib`。
- [x] 3. 品牌默认名置空、顶部标题隐藏未命名状态、弹窗预览清零默认名。
- [x] 4. 更新双语 README 的当前能力描述；同步 runtime-configuration 与 lightbox-image-viewer 规格。

## 验收

- [x] 5. 运行完整 `npm test`、发布检查、差异检查与 `openspec validate --all --strict`，通过后按要求归档。
