# 思考过程自动翻译（Reasoning auto-translate）

展开模型的思考（reasoning）时，自动把它翻译成界面语言；中文界面译为简体中文。译文默认直接显示，
工具栏里一键切回原文。翻译只发生在浏览器这一侧，不写入 Session 日志，也不改变模型上下文。

## 安装

1. 把这个目录克隆（或下载解压）到本地，例如 `git clone https://github.com/CNLing0728/dsh-cot-auto-translate.git`。
2. 打开 DSH 的「插件」页 → 「添加插件」→ 选择该目录（本地目录安装）。
3. 装好后插件页会出现「思考过程自动翻译」一行，启用即生效，不需要重启。

## 用法

1. 在插件面板启用本插件（启用后立即生效，不需要重启）。
2. 在任意会话里点开思考块（「已思考 …」那一行展开）。
3. 正文默认显示译文；顶部工具栏的「查看原文 / 查看译文」可以随时切换，切换按思考块记住
   （折叠再展开不会被重置）；「机器翻译」角标只出现在译文视图，鼠标悬停说明译文来源。
4. 正在流式输出的最后一段保持原文，已完成的段落先翻译；流式尾巴停顿约 1.2 秒后也会一起翻。
   工具栏同时显示「已翻 / 总段数」进度。失败时显示原文，提示「翻译暂不可用，当前显示原文」
   并给出「重试」；代码围栏内的内容不送翻。

目标语言跟随界面语言：中文（含 zh-CN / zh-Hans）→ 简体中文，中文繁体（zh-TW / zh-HK）→ 繁体中文，
其它界面语言取语言码（en、ja、ru …）。正文本来就是中文时不发请求。

## 实现要点

- 覆盖 `conversation.chat.reasoning.body` 插槽（priority 40，盖过官方的 100），正文仍交给官方的
  `conversation.chat.reasoning.content` 工厂渲染，所以排版、Markdown、代码块样式与宿主一致。
- 按段落切分（超长段落在空白处再切），用 Microsoft Edge 匿名翻译端点一次请求多段，返回数组与
  入参一一对应；最多 3 个请求并行，结果按段缓存在页面内存里（折叠再展开不重复请求）。
- 只翻译已完成的段落，未完成的流式尾巴保留原文。

## 与内置「思考过程机器翻译」的关系

DSH 带一个实验特性「思考过程机器翻译」（`@deepseek-ai/dsh-experimental-cot-translation-bundle`）。
它在本机处于禁用态：profile 里解析到的是 0.2.2-rc.1 的包，而运行中的 DSH 是 0.2.2-rc.3，
启动时的兼容性预检会把这些行直接禁用（Plugins 页的开关因此点了也不生效）。本插件不依赖它，
也不修改它；两者不会同时工作，看到内置那条开关时保持关闭即可。

## 限制与注意

- 译文只存在于当前页面内存：刷新或重开会话后重新翻译（会重新发请求）。
- 翻译会把展开的思考正文发送给 Microsoft 的翻译端点；涉及敏感内容时请切回原文或停用插件。
- Microsoft 的匿名翻译端点没有第三方 API 保证，可能限流或改变响应格式；失败时插件保留原文，
  不会影响阅读。中国大陆网络的可达性随网络环境而定（本插件在本机已实测可用）。
- 被改写过的 Markdown（链接、代码块）可能变形；原文始终可切回。
- 目标语言跟随界面语言，插件不提供单选控件。

---

# Reasoning auto-translate

While a reasoning disclosure is expanded, its text is automatically translated into the interface
language. Chinese interfaces get Simplified Chinese. The original is always one click away, and the
translation lives only in the page: the Session log and the model context are untouched.

## Usage

Enable the plugin in the Plugins panel, expand any reasoning block, and the body defaults to the
translation; the toolbar above it switches between translation and original at any time. The still
streaming tail stays original while finished paragraphs are translated first. On failure the original
stays visible with a Retry action.

The target language follows the interface language (`zh`/`zh-CN`/`zh-Hans` → Simplified Chinese,
`zh-TW`/`zh-HK` → Traditional Chinese, other locales use their language code). Chinese reasoning is
not sent when the target is Chinese.

## Implementation

- Replaces the `conversation.chat.reasoning.body` slot (priority 40, ahead of the official 100) and
  still renders through the official `conversation.chat.reasoning.content` factory, so typography and
  Markdown match the host exactly.
- Splits the text into paragraphs (over-long ones at whitespace), sends several paragraphs per request
  to the anonymous Microsoft Edge translation endpoint (the response array maps 1:1 to the input),
  runs at most three requests in parallel, and caches results per paragraph in page memory.
- Only completed paragraphs are translated; the streaming tail follows once it pauses for about
  1.2 seconds, and the toolbar shows the finished/total paragraph count. Code fences and Chinese
  paragraphs (when the target is Chinese) are not sent. The view choice is remembered per reasoning
  block; a failure keeps the original visible with a Retry action.

## Limitations

- Translations are page-memory only: reloading the page or reopening a Session translates again.
- The displayed reasoning text is sent to Microsoft's translation endpoint. Disable the plugin or use
  the original view for sensitive content.
- The anonymous endpoint has no third-party API guarantee: it may rate-limit or change its response
  format. Failures keep the original text.
- Markdown links and code fences may be altered; the original is always available.
