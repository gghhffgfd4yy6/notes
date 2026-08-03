# 🐛 真实 Bug 待评估（BUG_HUNT）

> 只收录**未修复**的、真实触发、有实际影响（非边缘/罕见/理论/企业级）的 bug。
> 每项经**真实验证**（真实接口数据 + 真实配置 + 真实通道），标注风险与收益。
> 当前状态：仅评估，未修复。

---

## 1. `{Html内容}` 模板 + Markdown 通道 → HTML 源码裸露

- **触发场景**：用户配置 `{Html内容}` 模板 + wxpusher / Server酱（Markdown 渲染通道）
- **真实验证**（2026-08-03，真实接口数据）：
  ```
  {Html内容} 输出: "京东APP 我的 优惠券--为你精选...<br>京东app搜索...<br><a href=\"https://u.jd.com/\"..."
  含 HTML 标签: ✅ 确认
  ```
- **风险**：推送内容显示 `<br>`、`<a href="...">` 等 **HTML 源码**，内容难读（wxpusher contentType=3 Markdown 不渲染 HTML）。当前用户唯一通道就是 wxpusher，若用 `{Html内容}` 模板必触发。
- **收益**：中——推送可读性（配置适配提示或 wxpusher 自动选 contentType 2=HTML）。
- **建议**：① wxpusher 检测内容含 HTML → 自动用 contentType=2（HTML 渲染）；② 或配置校验：`{Html内容}` 模板 + Markdown 通道时启动警告。
- **修复难度**：低（①一行判断 / ② validateConfig 加检查）。

## 2. 过滤条件变更后旧条目不重新推送（需手动清缓存）

- **触发场景**：用户**改宽过滤条件**（如原来屏蔽"京东"，改为不屏蔽）
- **真实验证**：被过滤的条目**已写入缓存**（设计：过滤=已处理）→ 改宽后这些条目被缓存判重跳过 → 不再推送
- **风险**：用户改配置后以为会收到新内容，实际旧条目不出现（需 `rm xianbaoku_cache/push.json`，README 有说明但用户易踩）
- **收益**：中——配置变更体验（缓存语义需区分"过滤写入"与"推送写入"）
- **建议**：缓存记录加"过滤时写入"标记，配置变更时（过滤规则哈希变化）自动失效相关缓存；或文档强化提示
- **修复难度**：中（缓存语义改动，需谨慎防重复推送）

## 3. 真实接口 `louzhuregtime` 全 null → pingbitime 配置永不生效

- **触发场景**：用户配置 `pingbitime`（楼主注册天数过滤）
- **真实验证**（2026-08-03，真实接口）：
  ```
  真实数据 louzhuregtime: null/缺失 20 条 | 有值 0 条
  配 pingbitime=5 拦截: 0/20（永不拦截）
  ```
- **风险**：用户配了天数过滤但**实际从不生效**（接口不提供该字段），且**无任何提示**——用户以为在过滤，实际没有
- **收益**：中——配置有效性提示（首次运行检测接口缺字段 → 警告）
- **建议**：App.run 首次运行统计 louzhuregtime 缺失率，>阈值时 console.warn「接口未提供注册时间字段，pingbitime 过滤不会生效」
- **修复难度**：低（运行统计 + 警告）

---

## 附：验证方法（可复现）

```bash
# 候选1：{Html内容} 模板输出
node -e "require('./xbk_function_v3.js').fetchData().then(d => console.log(require('./xbk_function_v3.js').tuisong_replace('{Html内容}', d[0]).slice(0,100)))"
# 候选3：pingbitime 有效性
node -e "const x=require('./xbk_function_v3.js');x.fetchData().then(d=>{const c=x.compileRules({pingbitime:'5'});console.log('拦截',d.filter(i=>!x.listfilter(i,c)).length,'/',d.length)})"
```

---

## 状态说明
- 三个候选均**真实验证触发**、风险明确、收益中等、修复难度低-中
- **未修复**（按你的要求：只找、验证、记录，不修）
- 若决定修，建议优先级：**1（wxpusher 当前唯一通道，易触发）→ 3（配置无效无提示）→ 2（配置变更体验）**
