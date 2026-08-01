# ✅ 真机验证清单（VERIFY.md）

> 目的：消除「mock 全绿 ≠ 真实可用」的验证盲区。
> 用法：每项实测后填 ✅/❌ + 备注；完成后把结果回填到本文件并提交。
> 当前代码版本：v3.105（658 测试全绿）

---

## 一、接口验证（new.ixbk.net）— ✅ 已实测（2026-08-01 沙箱，接口可达）

| # | 验证项 | 预期 | 结果 | 备注 |
|---|---|---|---|---|
| 1.1 | `node xbk_function_v3.js` 完整运行 | 拉取成功、无异常 | ✅ | 接口 200，返回 20 条 |
| 1.2 | 接口返回结构（拉取条数） | 与接口实际条数一致 | ✅ | 数组 20 条，字段：id/title/content/content_html/datetime/shorttime/shijianchuo/cateid/catename/comments/louzhu/louzhuregtime/url |
| 1.3 | `category_name` → `catename` 映射 | 分类显示正确 | ✅ | 接口直接用 catename（'好单线报-更多-京东'），无 category_name——映射逻辑兼容 |
| 1.4 | 时间字段（posttime/shijianchuo） | {日期}/{时间} 显示正确 | ✅ | 接口返回 shijianchuo（秒时间戳 1785593676）+ 自带 datetime/shorttime（归一化直接用接口值） |
| 1.5 | `content_html` → Markdown 转换 | 推送内容格式正确 | ✅ | 图片 18/20、链接 20/20、换行正常；粗体/链接/图片全部正常 |
| 1.6 | 相对 URL 拼接 | 原文链接可点 | ✅ | url='/haodan/6730944.html' → urlOf 拼 domain |
| 1.7 | 无 id 数据（合成 id 去重） | 跨运行不重复推送 | ✅ | id 恒有（数字），不触发合成 id |
| 1.8 | **实体双重转义** | `&amp;amp;` → `&` | ✅ **已修复 v3.105** | 实测 2/20 条含 `&amp;amp;`（旧代码残留 `&amp;` 破坏 URL 参数）→ 递归解码修复 + 测试锁定 |

**接口验证结论**：✅ 字段映射全部正确；**发现并修复真实 bug 1 个**（双重转义，v3.105）

---

## 二、推送通道验证（9 通道）— ⬜ 待真机（当前环境无真实推送密钥）

| # | 通道 | 配置项 | 结果 | 备注 |
|---|---|---|---|---|
| 2.1 | Push+ | PUSH_PLUS_TOKEN | ⬜ | |
| 2.2 | Server酱 | PUSH_KEY | ⬜ | SCT 前缀走 Turbo |
| 2.3 | Bark | BARK_PUSH | ⬜ | 多设备分割/扩展参数 |
| 2.4 | PushMe | PUSHME_KEY | ⬜ | |
| 2.5 | 企业微信 | QYWX_KEY | ⬜ | |
| 2.6 | wxpusher | WX_pusher_appToken | ⬜ | topicIds 数组 |
| 2.7 | 息知 | WX_XIZHI_KEY | ⬜ | |
| 2.8 | PushDeer | DEER_KEY | ⬜ | |
| 2.9 | Telegram | TG_BOT_TOKEN+TG_USER_ID | ⬜ | **重点：parse_mode 决策** |

### 2.9 TG 专项（决策项）
- 推送含 `* _ [ ]` 等特殊字符的文本 → 渲染是否正常？
  - 正常 → 维持 `parse_mode: 'Markdown'` ✅
  - 异常 → 改 `parse_mode: 'HTML'` + 转义（已记录 REVIEW_DECISIONS 12）
- 自定义 TG_API_HOST 是否工作？

## 三、运行场景验证

| # | 场景 | 预期 | 结果 | 备注 |
|---|---|---|---|---|
| 3.1 | 连续运行 2 次 | 第 2 次全部去重跳过（不重复推送） | ⬜ | 需真实密钥跑完整流程 |
| 3.2 | 清缓存后运行 | 全部重新推送 | ⬜ | `rm xianbaoku_cache/push.json` |
| 3.3 | `xianbaoku_cache/run.log` | 有摘要行（total/dedup/pushed/elapsed） | ⬜ | |
| 3.4 | 断网运行 | 重试 3 次后报错、exit 1 | ⬜ | cron 可感知 |
| 3.5 | cron 定时运行 | 每 N 分钟自动推送 | ⬜ | |
| 3.6 | 并行模式（push.mode='parallel'） | 推送正常、摘要正确 | ⬜ | |

## 四、日志安全验证

| # | 验证项 | 预期 | 结果 | 备注 |
|---|---|---|---|---|
| 4.1 | cron 日志重定向后 | 不含任何完整密钥 | ⬜ | `grep -i key /var/log/...` |
| 4.2 | 通道失败时日志 | 只显示错误摘要（非响应体） | ⬜ | |

---

## 回填说明
- 每项完成后把 ⬜ 改为 ✅（或 ❌ + 备注）
- 全部完成后更新本文件头部版本号与日期，提交一次「真机验证记录」
- **接口验证（一）已于 2026-08-01 在沙箱实测完成**；推送通道验证（二）需真实密钥环境

