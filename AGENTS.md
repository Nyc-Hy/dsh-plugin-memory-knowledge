# AGENTS.md

本仓库专门用于开发 DeepSeek Harness 的 Memory & Knowledge 树外插件。

## 仓库模型

- `main` 是插件主线，仓库根目录必须始终能够独立安装、构建、测试和打包。
- 本仓库不承载其他插件实现。需要共享的代码应先判断是否值得成为独立依赖，避免复制隐含耦合。
- 修改 DeepSeek Harness 核心扩展点时，在 `deepseek-harness` 仓库单独完成；本仓库只消费公开接口。

## DSH 插件约定

- 可安装插件使用 `package.json#dsh.bundle` 声明配置层，并由 `cordis.patch.yml` 挂载插件行。
- 浏览器插件使用 `package.json#dsh.client` 和 `exports["./client"]` 声明客户端入口。
- 运行时代码使用 ESM 和 TypeScript strict 模式；注册行为必须跟随 Cordis effect 生命周期。
- 不依赖 DeepSeek Harness 仓库内未导出的源码路径。对 fork 专属扩展点声明明确的兼容版本。
- Git 安装需要执行构建脚本时，必须记录安装权限和风险；日常验收优先使用包含预构建产物的 tarball。

## 验收与安全

- 使用隔离 profile 验证安装、启动、禁用、更新和卸载。
- 用户可见的界面改动必须用真实 DSH 应用流程验证。
- 不提交凭据、`.env`、个人 profile、会话日志、附件、构建缓存或本机绝对路径。
- 文档、界面文字和代码注释默认使用中文；外部协议和既有英文标识保持原样。
