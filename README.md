# 知辩 Zhibian

知辩是一台知乎观点压力测试器：用户先写下自己的判断，再阅读不同立场的社区材料，最后重新判断。它不替用户下结论，而是把“我为什么这样想”变得更具体、可回看、可分享。

## 体验路径

1. 输入一个争议问题，或选择首页的示例话题。
2. 先锁定自己的立场与理由。
3. 阅读观点海图、代表性来源和来源绑定的挑战。
4. 完成二次判断，查看观点成长卡并生成分享图卡。

默认运行在 mock 模式，页面会明确标注演示数据。真实知乎数据模式是可选配置，凭证只应注入服务端环境，不进入浏览器代码、仓库或日志。

## 主要能力

- 确定性融合、去重、四簇观点分类与可解释的光谱布局。
- source-gated 挑战：没有可追溯来源就不生成挑战内容。
- 观点的立场、条件性和证据类型分离保存，避免把复杂表达压成单一结论。
- 同源服务端代理，统一处理鉴权、Origin/CSRF、限流、缓存、审计和降级。
- 游客可直接体验的完整主流程，以及 Before / After 分享图卡。
- 纯 Node.js 运行，不要求前端构建工具。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
cp .env.example .env
node server.mjs
```

然后打开 <http://127.0.0.1:4173>。

默认 provider 是 `mock`。如需接入真实上游，请在受保护的服务端环境中设置 `ZHIBIAN_PROVIDER=http` 和 `ZHIHU_ACCESS_SECRET`，并配置允许的 Origin；不要把真实值写入 `.env.example` 或提交到 Git。

## 测试

```bash
node --test test/unit/*.test.mjs
for f in _smoke.mjs _smoke_*.mjs; do node "$f"; done
```

数据集检查和离线评测：

```bash
node scripts/validate-dataset.mjs regression-cases.json
node scripts/evaluate-dataset.mjs --file=data/hard-cases.json
```

## 目录结构

```text
index.html              页面结构
styles.css              页面样式
assets/                 推荐话题图片与组件样式
src/                    浏览器端核心逻辑、适配器与数据处理模块
server.mjs              本地/生产兼容的同源 API 代理
data/                   脱敏的演示数据与评测样例
scripts/                数据校验与离线评测脚本
test/unit/              Node.js 单元测试
_smoke*.mjs             端到端安全边界与主流程回归脚本
docs/adr/               关键设计决策记录
```

## 公开范围说明

公开仓库只包含可复现的代码、演示数据、测试和必要的静态资源。个人配置、密钥、真实账号数据、本地运行记录、部署目标、录屏/设计稿和过程材料不属于仓库内容。默认演示数据不代表真实知乎回答，真实模式是否可用取决于运行环境中的官方接口配置。

## 安全边界

- 浏览器不持有上游凭证，服务端才可以访问真实接口。
- 日志与审计记录对凭证、正文和敏感字段做脱敏处理。
- Origin 白名单、CSRF 检查、请求限流和配额保护默认开启对应边界。
- 没有真实凭证时，服务会明确降级，不把 mock 内容包装成真实结果。
