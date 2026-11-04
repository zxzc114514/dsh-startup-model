# dsh-model-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: DeepSeek Harness](https://img.shields.io/badge/Platform-DeepSeek%20Harness-brightgreen.svg)](https://github.com/deepseek-ai)

每次启动 DeepSeek Harness (DSH) 时，自动使用上次退出前选择的模型。

Starts every DSH run on the model you were using when you last quit, eliminating the need to manually re-select your preferred model on every restart.

---

## 痛点与核心特性 (Features)

在 DeepSeek Harness 中，新会话默认使用 profile 模板配置中定义的默认模型。用户在具体会话中切换模型后，退出重新打开或新建会话时往往需要重新点选。

`dsh-model-memory` 通过监听持久化会话事件，将最后一次用户主动选用的模型安全记录到本地状态文件中，并在下一次启动时平滑注入为默认模型：

- **纯 Host 端微内核架构**：纯 Node.js 服务实现，不侵入渲染层（无前端 Client 依赖），完全杜绝因渲染端脚本异常导致的 Web Boot 白屏崩溃（All-or-nothing failure）。
- **子代理隔离保护 (Subagent Isolation)**：智能识别会话上下文（`origin: subagent` 或 `delegationDepth > 0`），子代理在执行专项任务时临时切换的轻量模型不会误污染全局默认配置。
- **原子替换与防抖落盘**：内置 500ms 事件防抖与进程级临时文件原子替换（Atomic rename），防止高频写盘与意外断电导致的状态文件损坏。
- **Provider 存活性与降级熔断**：启动恢复前校验模型 Provider 是否仍处于注册路由状态。若该模型服务已被用户卸载或停用，插件将安全跳过并保留当前配置，避免系统陷入死循环。
- **完整保留思考深度档位**：支持记录与恢复 `reasoningEffort`（如 high / medium / low）。

---

## 安装方法 (Installation)

### 方式一：通过 DSH 插件市场 (Market)
在 DeepSeek Harness 插件管理器中搜索并安装 `dsh-model-memory`。

### 方式二：手动引入配置 (Manual)
在 DSH profile 的 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中引入本插件：

```json
{
  "dependencies": {
    "dsh-model-memory": "https://github.com/zxzc114514/dsh-model-memory/releases/latest/download/dsh-model-memory.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-model-memory"
      ]
    }
  }
}
```

插件自带的 bundle patch 将自动挂载生效。

---

## 配置参数 (Configuration)

可在 profile 的 `cordis.patch.yml` 中为插件提供自定义配置（通常无需任何配置，开箱即用）：

```yaml
- id: model-memory
  name: 'dsh-model-memory'
  config:
    enabled: true
    trackSubagents: false
    # stateFile: 'C:/custom/path/model-memory.state.json'
```

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用模型记忆功能 |
| `trackSubagents` | `boolean` | `false` | 是否跟踪子代理派生会话中的模型变更（默认关闭以保护主模型） |
| `stateFile` | `string` | `~/.dsh/model-memory.state.json` | 状态持久化文件存放路径 |

---

## 工作原理 (How it Works)

1. **录制 (Record)**：普通用户会话派发 `model/selection` 或 `request/header` 事件时，插件提取并规范化模型三元组（`provider`, `model`, `reasoningEffort`），经过 500ms 防抖后原子写入状态文件。
2. **恢复 (Restore)**：DSH 启动时，插件通过 `ctx.inject(['agentDefaultModel'])` 挂载，校验本地状态有效性与 Provider 可达性后，调用 `agentDefaultModel.saveSelection()` 恢复启动默认值。

---

## 开源协议 (License)

[MIT License](LICENSE) © 2026 ImportCoffee
