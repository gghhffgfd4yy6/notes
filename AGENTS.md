# 项目规则

xbk-push：个人青龙**单实例**线报推送脚本。

## 必守

- 不提交密钥、缓存或本地配置。
- 破坏性 Git 操作前：`git bundle create backup.bundle --all && git bundle verify backup.bundle`；不得手动删除 `.git/objects`。
- 修改后先验证再称完成；提交前至少运行受影响测试，常规改动跑 `npm test`。
- 一次提交只做一件事；改版本时同步主文件头、`CHANGELOG.md`、`package.json`。
- 推送前确认分支和远程；`origin`、`gitee` 均需推送。禁止浅克隆处理远程历史。

## 常用命令

```bash
npm test
npm run test:filter
npm run test:app
npm run test:notify
npm run test:mutation
```

高风险区域：判重/缓存、推送结果、配置兼容、网络请求、正则防护。改动须补回归测试。完整行为约束见 `SYSTEM_CONTRACT.md`；运行方式见 `README.md`。
