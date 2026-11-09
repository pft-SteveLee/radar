<!-- 這份是草稿，由使用者維護：changelog_watch 的摘要會用它來寫「對我們的影響」。請直接改成團隊實際的狀況。 -->

## 工作方式

- 主要用 Claude Code 寫程式，搭配 superpowers（brainstorming、TDD、systematic-debugging、writing-plans、executing-plans）和 ponytail（最小改動）等 skills。
- 用 herdr 管理多個 agent 與終端 pane。
- 報告與文件發佈到內部 CodiMD。
- 每月 Claude Max 方案附的 $100 API 額度，透過 Messages API 跑排程 job（radar 專案），Claude Code 不能用這筆額度。

## 已安裝的 plugins

superpowers、context7、code-simplifier、code-review、commit-commands、claude-code-setup、claude-md-management、mattpocock-skills、ui-ux-pro-max、bmad-method、ponytail、impeccable、pulumi-authoring。

## AMP 專案的 workspace

l10n、edm、dah（競品比較的第一批）。

## 判斷「影響」時請注意

- 新的 skill 或 plugin：說明它做什麼，跟上面已安裝的有沒有重疊。
- Claude API 或模型的價格、棄用變動：對 radar 目前用的 Haiku 5.5、Sonnet 5.5、Opus 5.5、Fable 5.1 的影響。
- herdr 的變更：是否牽涉 agent 編排、pane／worktree 工作流、plugin。
