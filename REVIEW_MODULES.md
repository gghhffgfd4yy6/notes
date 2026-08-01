# 📋 模块化审查记录（REVIEW_MODULES.md）

> 规划-阶段2：11 个模块逐一出审查报告（已覆盖/未覆盖/已知取舍），**先审后改**。
> 当前代码版本：v3.104（657 测试全绿）

---

## 模块 1/11：Config（配置层）

**审查日期**：2026-08-01

### 已覆盖
- ✅ 全部配置项有中文注释（domain/api/filter/keyword/timing/push/template/cache）
- ✅ 默认值契约测试（domain/filter 旧字段 + template/push 新字段，v3.97）
- ✅ 运行时数值/类型校验（v3.64 timeout/retry/pushInterval/finalWait/parallelLimit；v3.73 domain；v3.80 template/cache.dir；v3.94 pushUrl 尾斜杠）
- ✅ 配置矩阵测试（t51：13 项非法值并行不崩）

### 未覆盖 / 待改进
- ⬜ 无（本模块审查未发现新问题）

### 已知取舍（详见 REVIEW_DECISIONS）
- 不冻结 Config（Object.freeze）——测试需动态改配置（决策 1）

**结论**：✅ 无修复项，维持现状

---

## 模块 2/11：Utils（工具层）

**审查日期**：2026-08-01

### 已覆盖
- ✅ parseTime 统一日期解析（v3.62 重构，99/100 章锁定）
- ✅ daysComputed/daysFrom 边界（99 章 TS_BOUND 精确分界；变异 6 红锁定）
- ✅ normUrl 幂等/极端（82/99 章）
- ✅ hasValidId 类型收紧（v3.43，布尔/对象/Symbol 无效）
- ✅ anonKey 确定性（82 章）
- ✅ decodeHtmlEntities 36 实体 + 数字/hex + 代理区/NUL（91/99/102 章）
- ✅ truncateUtf16 代理对安全（v3.42）
- ✅ hasNestedQuantifier ReDoS 检测（v3.35，95 章）

### 未覆盖 / 待改进
- ⬜ 无（本模块审查未发现新问题）

### 已知取舍
- anonKey djb2 32 位哈希（决策 #39）；拼接歧义（#40）；日期时区（#22）；类型误用静默（#15/16）

**结论**：✅ 无修复项，维持现状

---

## 模块 3/11：Formatter（格式化层）

**审查日期**：2026-08-01

### 已覆盖
- ✅ htmlToMarkdown 标签转换（h/a/img/br/p/列表/粗斜体/表格/script-style 移除/剥标签/换行合并，v3.33-51 多轮）
- ✅ 快照锁定（84 章 6 个完整输出）
- ✅ 惰性计算（31/39 章）
- ✅ {链接}/{Html内容} Markdown/HTML 安全化（v3.74/85）
- ✅ tuisong_replace 占位符 18 个 + 时间口径（v3.46/47/62）
- ✅ 实体解码顺序（先剥标签后解码）

### 未覆盖 / 待改进
- ⬜ 无（本模块审查未发现新问题）

### 已知取舍
- 链接文本嵌套标签样式丢失（决策 7）；&amp;amp; 非递归（#45）；HTML 容忍边界（#51/54/55/57/61）

**结论**：✅ 无修复项，维持现状

---
