// test/_vm-sandbox.js — 唯一的动态执行入口（SonarCloud javascript:S1523 的收口点）
//
// 为什么单独成文件：C7-030 / C7-032 两族用例要执行 scripts/console-assets/*.js 的**源码切片**
// （用 acorn 定位后切出来跑，确保测的是真实实现而不是副本）。SonarCloud 的 S1523 是纯语法规则：
// 看到 vm.runInNewContext 就报，无法区分「执行仓库内常量源码」与「执行外部输入」。
//
// 处理：把 sink 收敛到本文件，并按仓库既有做法（.sonarcloud.properties 的 sonar.exclusions
// 是自动分析**支持**的 scope 类设置；multicriteria 才不支持）把本文件排除在分析之外。
// 调用点保留可读性，规则在其它文件仍照常生效——不是全局关闭 S1523。
//
// 安全边界（写清，别改成接受外部输入）：入参只能是本进程读到的仓库文件切片或其它字符串常量；
// 上下文对象由用例显式构造（没有 require / process / fs）。vm 不是安全沙箱，这里也不需要它是。
const vm = require('node:vm')

function runInSandbox (code, context) {
  return vm.runInNewContext(code, context)
}

module.exports = { runInSandbox }
