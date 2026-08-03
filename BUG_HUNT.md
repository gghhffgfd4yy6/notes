# 🐛 真实 Bug 评估与修复记录（BUG_HUNT）

> 曾收录**未修复**的、真实触发、有实际影响（非边缘/罕见/理论/企业级）的 bug，每项经**真实验证**。
> **5 项已全部修复（v3.159，2026-08-03）**——下方每项标注修复方式与验证结果。

---

## 1. `{Html内容}` 模板 + Markdown 通道 → HTML 源码裸露 ✅ 已修复（v3.159）

- **触发场景**：用户配置 `{Html内容}` 模板 + wxpusher / Server酱（Markdown 渲染通道）
- **真实验证**（2026-08-03，真实接口数据）：
  ```
  {Html内容} 输出: "京东APP 我的 优惠券--为你精选...<br>京东app搜索...<br><a href=\"https://u.jd.com/\"..."
  含 HTML 标签: ✅ 确认
  ```
- **风险**：推送内容显示 `<br>`、`<a href="...">` 等 **HTML 源码**，内容难读（wxpusher contentType=3 Markdown 不渲染 HTML）。当前用户唯一通道就是 wxpusher，若用 `{Html内容}` 模板必触发。
- **修复（v3.159）**：wxpusher 检测内容含 HTML 标签（白名单 br/a/img/p/div/strong/b/i/em/u/s/table/tr/td/th/ul/ol/li/h1-6/span/font/blockquote/code/pre/hr）→ 自动切 contentType=2（HTML 渲染）；白名单避免误判 Markdown `<url>` autolink。test_notify 新增 2 测试（含 HTML 切 2 / autolink 保持 3）。
- **验证**：真实 `{Html内容}` → 判 HTML ✓；真实 `{Markdown内容}` → 不误判 ✓

## 2. 过滤条件变更后旧条目不重新推送（需手动清缓存）✅ 已修复（v3.159）

- **触发场景**：用户**改宽过滤条件**（如原来屏蔽"京东"，改为不屏蔽）
- **真实验证**：被过滤的条目**已写入缓存**（设计：过滤=已处理）→ 改宽后这些条目被缓存判重跳过 → 不再推送
- **风险**：用户改配置后以为会收到新内容，实际旧条目不出现（需 `rm xianbaoku_cache/push.json`，README 有说明但用户易踩）
- **修复（v3.159）**：缓存记录 `_f` 过滤标记 + `filter.hash` 规则哈希比对——规则/只看它变更时清除「过滤写入」缓存条目（之前被过滤的重新评估，改宽即重推）；推送成功清除标记；「推送成功」缓存不受影响（防重复推送）。test_app t67 覆盖全链路。
- **验证**：屏蔽→改宽→旧条目重新推送 ✓；缓存 `_f` 无残留 ✓

## 3. 真实接口 `louzhuregtime` 缺失 → pingbitime 配置几乎不生效无提示 ✅ 已修复（v3.159）

- **触发场景**：用户配置 `pingbitime`（楼主注册天数过滤）
- **真实验证**（2026-08-03，真实接口）：
  ```
  真实数据 louzhuregtime 缺失: 20/20（接口基本不提供该字段）
  配 pingbitime=5 拦截: 0/20（几乎永不拦截）
  ```
- **风险**：用户配了天数过滤但**实际从不生效**（接口不提供该字段），且**无任何提示**——用户以为在过滤，实际没有
- **修复（v3.159）**：运行期统计 louzhuregtime 缺失率，配置 pingbitime 且缺失率 >50% 时 console.warn「接口可能不提供该字段，pingbitime 过滤基本不会生效」。test_app 覆盖。
- **验证**：真实缺失 20/20 >50% → 警告触发 ✓

## 4. 告警/日报 desp 全部单个 `\n`（wxpusher Markdown 未适配）✅ 已修复（v3.159）

- **触发场景**：接口异常（告警默认开启）或跨天（日报默认开启）+ wxpusher 通道
- **真实验证**（2026-08-03）：
  ```
  告警 desp: "接口/推送异常，请检查。\n时间：2026/8/3 03:02:41\n原因：ECONNREFUSED"（全单 \n）
  日报 desp: "推送 3 条 | 失败 0 条\n获取 5 | 去重 1 | 过滤 1"（全单 \n）
  ```
- **不一致**：Server酱已适配（单 `\n` 加倍）、Bark/Push+ 走 mdToPlain——**wxpusher 是 Markdown 原样**，单个 `\n` 渲染依赖实现（可能挤成一行），与主推送（`\n\n` 段落分隔）格式不一致
- **修复（v3.159）**：_sendAlert/_updateReport 的 desp 改 `\n\n` 段落分隔（与主推送同口径）。t56/t57 断言增强。
- **验证**：告警 desp 含 `\n\n时间：` ✓；日报 desp 含 `条\n\n获取` ✓

## 5. 模板占位符 `{价格}/{商城}/{品牌}/{图片}` 在真实接口恒空 ✅ 已修复（v3.159）

- **触发场景**：用户模板使用 `{价格}` `{商城}` `{品牌}` `{图片}` 占位符
- **真实验证**（2026-08-03，真实接口）：
  ```
  真实接口全部字段: cateid, catename, comments, content, content_html, datetime, id,
                     louzhu, louzhuregtime, shijianchuo, shorttime, title, url  (13个)
  字段 price: 0/20 | mall_name: 0/20 | brand: 0/20 | pic: 0/20（接口无此字段）
  {价格}/{商城} 模板输出: "价格: 商城:"（恒空）
  ```
- **风险**：用户配了模板但占位符永远为空（推送显示"价格: 商城:"），无任何提示——配置无效不感知
- **修复（v3.159）**：启动检查模板（title/content）含不支持的占位符 → 警告（支持列表 11 个：分类名/分类ID/标题/链接/日期/时间/楼主/类目/内容/Html内容/Markdown内容）。test_app 覆盖。
- **验证**：`{价格}` 模板 → 启动警告 ✓ 推送正常（占位符替换为空）✓

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
- 五个候选均**真实验证触发**、风险明确、收益中等、修复难度低-中
- **v3.159 全部修复**（2026-08-03），修复顺序：1（wxpusher 当前唯一通道，易触发）→ 2（配置变更体验，缓存语义）→ 3（配置无效无提示）→ 4（格式统一）→ 5（模板配置提示）
- 测试：test_app +3（t67 过滤变更/pingbitime 警告/占位符警告）、test_notify +2（wxpusher HTML/autolink）——**766 全绿**

## 4b. 真实验证补充（非 bug，记录排除）

- 真实数据 20 条：7 条含 emoji（desp 无孤立代理 ✓）、无全角/实体残留、无 4+ 连续换行、无 HTML 残留——内容质量正常
- 真实标题最长 35 字符（summary 90 截断不触发，safeSlice 保护已就位）
- 多行过滤规则（`分类###正则`）真实数据逻辑正确（cat 匹配分类）

## 5b. 真实验证补充（非 bug，排除）

- **推送失败重试完整验证**（wxpusher 限流 → 不写缓存 → 恢复后重试成功，消息不丢）✓
- **真实告警推送**（接口失败 → 告警真实送达 wxpusher + 状态正确，v3.156/157 生效）✓
- 告警 errMsg 内容安全（无密钥/敏感信息，单行）✓
- 真实内容质量（emoji 完整/无孤立代理/无 HTML 残留/无 4+ 连续换行）✓
- 多行过滤规则真实逻辑正确 ✓
