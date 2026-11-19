// 思考过程自动翻译 —— Client 半。
//
// 展开的思考正文由 `conversation.chat.reasoning.body` 单值插槽渲染。官方那条注册
// （priority 100）只是把 text/running 透传给 `conversation.chat.reasoning.content`
// 工厂；本插件以更小的 priority（40）覆盖它：
//
//   * 默认显示译文：展开即自动翻译，不用点任何按钮；
//   * 按段落切分、按整句边界合并，一次请求最多 12 段，返回数组按下标一一对应
//     （Bing Edge 端点原生支持一次请求多段文本）；
//   * 正在流式输出的最后一段先保留原文，停稳约 1.2 秒后补翻；
//   * 最多 3 个请求并行；一次调度翻不完就自动续跑，不会翻一半停住；
//   * 结果按段缓存（同一段思考折叠再展开不重复请求）；代码围栏与
//     已经成为目标语言的段落不送翻；
//   * 失败时显示原文并说明「当前显示原文」，给「重试」；
//   * 工具栏一键在「译文 / 原文」之间切换，选择按思考块记住；
//     正文渲染仍交给官方 Content 工厂，所以排版、Markdown、代码块样式与宿主一致。
//
// 说明：译文只存在于这个页面的内存里，不会写进 Session 日志；原文始终可由
// 「查看原文」得到。模型上下文与历史记录不受影响。

window.__ModuleLoader__.load({
  id: 'dsh-cot-auto-translate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NS = 'cotAutoTranslate'

    /** Microsoft Edge 的匿名翻译端点：无需登录或 API Key，浏览器端可跨域直连。 */
    const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
    /** 单次请求截止时间。 */
    const REQUEST_TIMEOUT_MS = 20000
    /** 单个文本片段的上限：端点按 4000 字符切分更稳妥。 */
    const MAX_UNIT_CHARS = 4000
    /** 一次请求的正文预算（多段合计）。 */
    const MAX_BATCH_CHARS = 12000
    /** 一次请求最多装几段。 */
    const MAX_BATCH_UNITS = 12
    /** 同时在飞的请求数。 */
    const CONCURRENCY = 3
    /** 一次调度最多翻译多少段；没翻完会继续下一轮。 */
    const MAX_UNITS_PER_PASS = 40
    /** 流式尾巴停稳多久之后，也把最后一段送去翻译。 */
    const TAIL_SETTLE_MS = 1200
    /** 页面内译文缓存上限（按段）。 */
    const CACHE_LIMIT = 800
    /** 已翻好的段落：`目标语言 \u0000 原文` -> 译文。 */
    const cache = new Map()
    /** 每个思考块记住用户选的视图：块首 96 字 -> 'translated' | 'original'。 */
    const viewMemory = new Map()
    const VIEW_MEMORY_LIMIT = 200
    /** 首次使用前必须由用户明确同意：把展开的思考原文发送给微软翻译。 */
    const CONSENT_KEY = 'dsh.cotAutoTranslate.consent.v1'

    /**
     * 读取用户对「思考原文会发送给 Microsoft Bing」的授权状态。
     * @returns 'granted'、'declined'，或从未选择过的 'unset'。
     */
    function readConsent() {
      try {
        const value = window.localStorage.getItem(CONSENT_KEY)
        return value === 'granted' || value === 'declined' ? value : 'unset'
      } catch (_unavailable) {
        return 'unset'
      }
    }

    /** 记住用户的选择；存储不可用时只影响下次打开是否再问。 */
    function writeConsent(value) {
      try { window.localStorage.setItem(CONSENT_KEY, value) } catch (_unavailable) { /* storage disabled */ }
    }

    const dicts = {
      zh: {
        showOriginal: '查看原文',
        showTranslation: '查看译文',
        translating: '正在翻译…',
        machine: '机器翻译',
        badgeTitle: '译文由 Microsoft Bing 生成：展开的思考文本会发送给 Microsoft',
        failed: '翻译暂不可用，当前显示原文',
        retry: '重试',
        groupLabel: '思考翻译',
      },
      en: {
        showOriginal: 'Show original',
        showTranslation: 'Show translation',
        translating: 'Translating…',
        machine: 'Machine translation',
        badgeTitle: 'Translated by Microsoft Bing: the expanded reasoning text is sent to Microsoft',
        failed: 'Translation unavailable — showing the original',
        retry: 'Retry',
        groupLabel: 'Reasoning translation',
      },
      ja: {
        showOriginal: '原文を表示',
        showTranslation: '翻訳を表示',
        translating: '翻訳中…',
        machine: '機械翻訳',
        badgeTitle: 'Microsoft Bing による翻訳です。展開した思考テキストは Microsoft に送信されます',
        failed: '翻訳を利用できません。原文を表示しています',
        retry: '再試行',
        groupLabel: '思考の翻訳',
      },
      ko: {
        showOriginal: '원문 보기',
        showTranslation: '번역 보기',
        translating: '번역 중…',
        machine: '기계 번역',
        badgeTitle: 'Microsoft Bing 번역입니다. 펼친 사고 텍스트가 Microsoft로 전송됩니다',
        failed: '번역을 사용할 수 없어 원문을 표시합니다',
        retry: '다시 시도',
        groupLabel: '사고 번역',
      },
      ru: {
        showOriginal: 'Показать оригинал',
        showTranslation: 'Показать перевод',
        translating: 'Перевод…',
        machine: 'Машинный перевод',
        badgeTitle: 'Перевод Microsoft Bing: раскрытый текст рассуждений отправляется в Microsoft',
        failed: 'Перевод недоступен — показан оригинал',
        retry: 'Повторить',
        groupLabel: 'Перевод рассуждений',
      },
      fr: {
        showOriginal: "Voir l'original",
        showTranslation: 'Voir la traduction',
        translating: 'Traduction…',
        machine: 'Traduction automatique',
        badgeTitle: 'Traduit par Microsoft Bing : le texte de raisonnement est envoyé à Microsoft',
        failed: 'Traduction indisponible — original affiché',
        retry: 'Réessayer',
        groupLabel: 'Traduction du raisonnement',
      },
      de: {
        showOriginal: 'Original anzeigen',
        showTranslation: 'Übersetzung anzeigen',
        translating: 'Übersetzung…',
        machine: 'Maschinenübersetzung',
        badgeTitle: 'Übersetzt von Microsoft Bing: der Denktext wird an Microsoft gesendet',
        failed: 'Übersetzung nicht verfügbar — Original wird angezeigt',
        retry: 'Erneut versuchen',
        groupLabel: 'Übersetzung der Denkschritte',
      },
      es: {
        showOriginal: 'Ver original',
        showTranslation: 'Ver traducción',
        translating: 'Traduciendo…',
        machine: 'Traducción automática',
        badgeTitle: 'Traducido por Microsoft Bing: el texto del razonamiento se envía a Microsoft',
        failed: 'Traducción no disponible: se muestra el original',
        retry: 'Reintentar',
        groupLabel: 'Traducción del razonamiento',
      },
      pt: {
        showOriginal: 'Ver original',
        showTranslation: 'Ver tradução',
        translating: 'Traduzindo…',
        machine: 'Tradução automática',
        badgeTitle: 'Traduzido pelo Microsoft Bing: o texto do raciocínio é enviado à Microsoft',
        failed: 'Tradução indisponível — exibindo o original',
        retry: 'Tentar novamente',
        groupLabel: 'Tradução do raciocínio',
      },
    }

    /**
     * 首次使用前的隐私告知文案：展开的思考原文会交给微软翻译服务，
     * 必须由用户点「启用翻译」后才开始发送任何内容。
     */
    const consentDicts = {
      zh: {
        consentNotice: '展开思考的原文会发送给 Microsoft Bing 翻译，用于生成译文；模型上下文和聊天记录不受影响。',
        enableTranslation: '启用翻译',
        keepOriginal: '保持原文',
        consentOff: '自动翻译已关闭',
      },
      en: {
        consentNotice: 'Expanded reasoning text is sent to Microsoft Bing to produce the translation. The model context and chat history are unaffected.',
        enableTranslation: 'Enable translation',
        keepOriginal: 'Keep original',
        consentOff: 'Auto-translation is off',
      },
      ja: {
        consentNotice: '展開した思考の原文は翻訳のため Microsoft Bing に送信されます。モデルの文脈とチャット履歴は変更されません。',
        enableTranslation: '翻訳を有効化',
        keepOriginal: '原文のまま',
        consentOff: '自動翻訳はオフです',
      },
      ko: {
        consentNotice: '펼친 사고의 원문은 번역을 위해 Microsoft Bing으로 전송됩니다. 모델 컨텍스트와 채팅 기록은 바뀌지 않습니다.',
        enableTranslation: '번역 사용',
        keepOriginal: '원문 유지',
        consentOff: '자동 번역이 꺼져 있습니다',
      },
      ru: {
        consentNotice: 'Раскрытый текст рассуждений отправляется в Microsoft Bing для перевода. Контекст модели и история чата не меняются.',
        enableTranslation: 'Включить перевод',
        keepOriginal: 'Оставить оригинал',
        consentOff: 'Автоперевод выключен',
      },
      fr: {
        consentNotice: 'Le texte de raisonnement est envoyé à Microsoft Bing pour la traduction. Le contexte du modèle et l’historique restent inchangés.',
        enableTranslation: 'Activer la traduction',
        keepOriginal: 'Garder l’original',
        consentOff: 'Traduction automatique désactivée',
      },
      de: {
        consentNotice: 'Der Denktext wird zur Übersetzung an Microsoft Bing gesendet. Modellkontext und Chatverlauf bleiben unverändert.',
        enableTranslation: 'Übersetzung aktivieren',
        keepOriginal: 'Original behalten',
        consentOff: 'Automatische Übersetzung ist aus',
      },
      es: {
        consentNotice: 'El texto del razonamiento se envía a Microsoft Bing para traducirlo. El contexto del modelo y el historial no cambian.',
        enableTranslation: 'Activar traducción',
        keepOriginal: 'Mantener original',
        consentOff: 'La traducción automática está desactivada',
      },
      pt: {
        consentNotice: 'O texto do raciocínio é enviado ao Microsoft Bing para tradução. O contexto do modelo e o histórico não mudam.',
        enableTranslation: 'Ativar tradução',
        keepOriginal: 'Manter original',
        consentOff: 'A tradução automática está desativada',
      },
    }

    const css = `
      .cot-auto { display: flex; flex-direction: column; gap: 6px; }
      .cot-auto__toolbar {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
        font-size: var(--dsh-content-font-size-secondary, 12px);
        line-height: 18px; color: var(--dsw-alias-label-secondary);
        user-select: none;
      }
      .cot-auto__toggle, .cot-auto__retry {
        appearance: none; font-family: inherit;
        font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px;
        color: var(--dsw-alias-label-secondary); background: transparent;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
        padding: 2px 10px; min-height: 24px; cursor: pointer;
      }
      .cot-auto__toggle:hover, .cot-auto__retry:hover {
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
      }
      .cot-auto__toggle:focus-visible, .cot-auto__retry:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
      }
      .cot-auto__badge, .cot-auto__status {
        font-size: var(--dsh-content-font-size-secondary, 12px);
        color: var(--dsw-alias-label-secondary);
      }
      .cot-auto__consent {
        font-size: var(--dsh-content-font-size-secondary, 12px);
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
        max-width: 46em;
      }
      .cot-auto__error {
        font-size: var(--dsh-content-font-size-secondary, 12px);
        color: var(--dsw-alias-state-error-primary);
      }
      .cot-auto__spinner {
        width: 10px; height: 10px; border-radius: 50%; display: inline-block;
        border: 1.5px solid var(--dsw-alias-border-l2);
        border-top-color: var(--dsw-alias-brand-primary);
        animation: cot-auto-spin 0.8s linear infinite;
      }
      @keyframes cot-auto-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .cot-auto__spinner { animation: none; }
      }
    `

    /** 把界面语言映射成端点可接受的目标语言标签。 */
    function targetTag(active) {
      const lower = String(active || '').toLowerCase()
      if (lower === '' || lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans' || lower === 'zh-sg') return 'zh-Hans'
      if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-Hant'
      return lower.split('-')[0] || 'en'
    }

    /** 目标已是中文、且这一段本来就是中文时不必发请求。 */
    function looksChinese(text) {
      const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)
      const visible = text.replace(/\s+/g, '').length
      return visible > 0 && (cjk === null ? 0 : cjk.length) / visible > 0.25
    }

    function cacheKey(target, source) {
      return target + '\u0000' + source
    }

    function remember(key, value) {
      if (cache.has(key)) cache.delete(key)
      cache.set(key, value)
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }

    function rememberView(blockKey, value) {
      if (blockKey === '') return
      viewMemory.delete(blockKey)
      viewMemory.set(blockKey, value)
      while (viewMemory.size > VIEW_MEMORY_LIMIT) {
        const oldest = viewMemory.keys().next().value
        if (oldest === undefined) break
        viewMemory.delete(oldest)
      }
    }

    /**
     * 把思考正文切成「单元」：段落，以及超长段落在空白处切出的前缀。
     * 单元各自记住尾随空白，拼回时逐字还原原文的换行结构。
     * 代码围栏内的单元标记 code，只保留原文、不送翻；仍在流式输出的最后一段
     * 标记未完成，先保留原文。
     */
    function splitUnits(text, pendingTail) {
      const units = []
      const separator = /\r?\n(?:[\t ]*\r?\n)+/g
      let start = 0
      let inFence = false
      while (true) {
        const match = separator.exec(text)
        let remaining = text.slice(start, match === null ? text.length : match.index)
        const fence = /```/.test(remaining)
        const code = inFence || fence || /^(?: {4,}|\t)\S/.test(remaining)
        if (fence) inFence = !inFence
        while (remaining.length > MAX_UNIT_CHARS) {
          let cut = MAX_UNIT_CHARS
          // 不要把代理对切成两半。
          const lastCode = remaining.charCodeAt(cut - 1)
          if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1
          const whitespace = remaining.slice(0, cut).search(/\s+\S*$/)
          if (whitespace > 0) cut = whitespace
          const source = remaining.slice(0, cut)
          remaining = remaining.slice(cut)
          const suffix = /^\s+/.exec(remaining)?.[0] ?? ''
          remaining = remaining.slice(suffix.length)
          units.push({ source, suffix, complete: true, code })
        }
        units.push({
          source: remaining,
          suffix: match === null ? '' : match[0],
          complete: match !== null || !pendingTail,
          code,
        })
        if (match === null) return units
        start = match.index + match[0].length
      }
    }

    /** 把待翻单元打包成请求：连续、不超段数、不超预算。 */
    function planBatches(items) {
      const batches = []
      let current = []
      let chars = 0
      for (const item of items) {
        const cost = item.source.length
        if (current.length > 0 && (current.length >= MAX_BATCH_UNITS || chars + cost > MAX_BATCH_CHARS)) {
          batches.push(current)
          current = []
          chars = 0
        }
        current.push(item)
        chars += cost
      }
      if (current.length > 0) batches.push(current)
      return batches
    }

    /** 一个请求带一个 AbortSignal：截止时间与组件卸载都能取消。 */
    function timeoutSignal(outer) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
      const forward = () => controller.abort(outer.reason)
      if (outer.aborted) {
        clearTimeout(timer)
        controller.abort(outer.reason)
      } else {
        outer.addEventListener('abort', forward, { once: true })
      }
      return {
        signal: controller.signal,
        dispose() {
          clearTimeout(timer)
          outer.removeEventListener('abort', forward)
        },
      }
    }

    /** 一次请求翻多段文本；返回与入参等长的译文数组。 */
    async function translateBatch(items, target, outer) {
      const body = JSON.stringify(items.map((item) => item.source))
      const url = ENDPOINT + '?to=' + encodeURIComponent(target) + '&isEnterpriseClient=false'
      const timeout = timeoutSignal(outer)
      try {
        const response = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          redirect: 'error',
          signal: timeout.signal,
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const payload = await response.json()
        if (!Array.isArray(payload) || payload.length !== items.length) {
          throw new Error('unexpected response shape')
        }
        return payload.map((entry) => {
          const translated = entry && entry.translations && entry.translations[0] && entry.translations[0].text
          if (typeof translated !== 'string') throw new Error('missing translation')
          return translated
        })
      } finally {
        timeout.dispose()
      }
    }

    /** 展开的思考正文：默认译文，一键切回原文。 */
    function AutoTranslatedBody(props) {
      const { text, rawText, running, renderFactorySlot, t } = props
      const active = props.useLocale((snapshot) => snapshot.active)
      const target = targetTag(active)

      const blockKey = useMemo(() => String(rawText || text).slice(0, 96), [rawText, text])
      const [view, setViewState] = useState(() => viewMemory.get(blockKey) ?? 'translated')
      const [revision, setRevision] = useState(0)
      const [busy, setBusy] = useState(0)
      const [failure, setFailure] = useState(null)
      const [attempt, setAttempt] = useState(0)
      // 首次使用前必须明确同意：在用户点「启用翻译」之前，不发送任何思考文本。
      const [consent, setConsent] = useState(() => readConsent())
      const granted = consent === 'granted'
      const decide = (value) => {
        writeConsent(value)
        setConsent(value)
      }

      // 流式尾巴在「停稳」一会儿之后也当作完整段落翻译：模型思考到一半时停顿时，
      // 已经写出的最后一段不该一直停在原文。快速连续出字时不断重置计时。
      const [tailSettled, setTailSettled] = useState(false)
      useEffect(() => {
        if (!running) {
          setTailSettled(true)
          return undefined
        }
        setTailSettled(false)
        const timer = setTimeout(() => setTailSettled(true), TAIL_SETTLE_MS)
        return () => clearTimeout(timer)
      }, [text, running])

      const pendingTail = running && !tailSettled
      const units = useMemo(() => splitUnits(text, pendingTail), [text, pendingTail])

      const needsWork = (unit) => unit.complete && !unit.code && unit.source.trim() !== ''
        && !cache.has(cacheKey(target, unit.source))
      const pendingUnits = useMemo(
        () => units.filter(needsWork).filter((unit) => !(target.startsWith('zh') && looksChinese(unit.source))),
        // revision 让缓存变化后重新统计进度。
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [units, target, revision],
      )
      const translatableCount = useMemo(
        () => units.filter((unit) => unit.complete && !unit.code && unit.source.trim() !== ''
          && !(target.startsWith('zh') && looksChinese(unit.source))).length,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [units, target],
      )
      const doneCount = Math.max(0, translatableCount - pendingUnits.length)

      // 只对「已完成的段落」敏感：流式增长的尾巴不断变化，不应反复重启请求。
      const settledKey = useMemo(() => {
        let count = 0
        let lastLength = 0
        for (const unit of units) {
          if (!unit.complete) continue
          count += 1
          lastLength = unit.source.length
        }
        return count + '|' + lastLength + '|' + (pendingTail ? '-' : text.length)
      }, [units, pendingTail, text.length])

      const abortRef = useRef(null)

      useEffect(() => {
        if (view !== 'translated' || !granted) return undefined
        const controller = new AbortController()
        abortRef.current = controller
        let alive = true
        let failed = false

        const translateAll = async () => {
          while (alive && !failed) {
            const missing = units.filter(needsWork)
              .filter((unit) => !(target.startsWith('zh') && looksChinese(unit.source)))
              .slice(0, MAX_UNITS_PER_PASS)
            if (missing.length === 0) break
            const batches = planBatches(missing)
            let cursor = 0
            setBusy((value) => value + batches.length)
            const worker = async () => {
              while (alive && !failed && cursor < batches.length) {
                const batch = batches[cursor]
                cursor += 1
                try {
                  const translated = await translateBatch(batch, target, controller.signal)
                  if (!alive) return
                  batch.forEach((item, index) => {
                    remember(cacheKey(target, item.source), translated[index])
                  })
                  setRevision((value) => value + 1)
                } catch (error) {
                  if (!alive || controller.signal.aborted) return
                  failed = true
                  setFailure(error instanceof Error ? error.message : String(error))
                  return
                } finally {
                  if (alive) setBusy((value) => Math.max(0, value - 1))
                }
              }
            }
            await Promise.all(
              Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()),
            )
          }
          if (alive) {
            setBusy(0)
            abortRef.current = null
          }
        }
        void translateAll()

        return () => {
          alive = false
          controller.abort(new Error('disposed'))
          if (abortRef.current === controller) abortRef.current = null
        }
        // settledKey 是 units 的稳定摘要；revision 只影响渲染，不重新排队请求。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [settledKey, target, view, attempt, granted])

      /** 译文正文：已翻段落用译文，未翻或流式尾巴保持原文。 */
      const translatedText = useMemo(() => {
        if (view === 'original' || failure !== null) return text
        let output = ''
        for (const unit of units) {
          const done = cache.get(cacheKey(target, unit.source))
          output += (done === undefined ? unit.source : done) + unit.suffix
        }
        return output
        // revision 让缓存命中变化后重新拼装。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [units, target, view, text, revision, failure])

      const anyTranslation = useMemo(() => {
        for (const unit of units) {
          if (cache.has(cacheKey(target, unit.source))) return true
        }
        return false
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [units, target, revision])

      const showTranslated = granted && view === 'translated' && failure === null && anyTranslation
      const showToolbar = !granted || anyTranslation || busy > 0 || failure !== null
      const toggleView = () => {
        const next = view === 'original' ? 'translated' : 'original'
        setViewState(next)
        rememberView(blockKey, next)
      }

      const status = busy > 0 && view === 'translated' && failure === null
        ? h(
          'span',
          { className: 'cot-auto__status', role: 'status' },
          h('span', { className: 'cot-auto__spinner', 'aria-hidden': 'true' }),
          ' ',
          translatableCount > 1
            ? t('translating') + ' ' + doneCount + '/' + translatableCount
            : t('translating'),
        )
        : null

      /** 未授权时只显示隐私告知与两个选择，点击前不发送任何思考文本。 */
      const consentRow = !granted
        ? [
          h(
            'span',
            { className: 'cot-auto__consent', key: 'notice' },
            consent === 'unset' ? t('consentNotice') : t('consentOff'),
          ),
          h(
            'button',
            {
              type: 'button',
              key: 'enable',
              className: 'cot-auto__toggle',
              onClick: () => decide('granted'),
            },
            t('enableTranslation'),
          ),
          consent === 'unset'
            ? h(
              'button',
              {
                type: 'button',
                key: 'keep',
                className: 'cot-auto__retry',
                onClick: () => decide('declined'),
              },
              t('keepOriginal'),
            )
            : null,
        ]
        : []

      return h(
        'div',
        {
          className: 'cot-auto',
          'data-cot-auto-translate': 'true',
          'data-cot-auto-view': showTranslated ? 'translated' : 'original',
          'data-cot-auto-state': failure !== null ? 'failed' : busy > 0 ? 'pending' : 'ready',
          'data-cot-auto-consent': consent,
        },
        h('style', null, css),
        showToolbar
          ? h(
            'div',
            { className: 'cot-auto__toolbar', role: 'group', 'aria-label': t('groupLabel') },
            ...consentRow,
            granted && anyTranslation && failure === null
              ? h(
                'button',
                { type: 'button', className: 'cot-auto__toggle', onClick: toggleView },
                t(view === 'original' ? 'showTranslation' : 'showOriginal'),
              )
              : null,
            showTranslated
              ? h('span', { className: 'cot-auto__badge', title: t('badgeTitle') }, t('machine'))
              : null,
            status,
            failure !== null
              ? h('span', { className: 'cot-auto__error', role: 'alert' }, t('failed'))
              : null,
            failure !== null
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'cot-auto__retry',
                  onClick: () => {
                    setFailure(null)
                    setAttempt((value) => value + 1)
                  },
                },
                t('retry'),
              )
              : null,
          )
          : null,
        renderFactorySlot('conversation.chat.reasoning.content', {
          text: showTranslated ? translatedText : text,
          running,
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = Object.entries(dicts).map(([id, dict]) => ctx.locale.register(NS, id, {
            ...dict,
            ...(consentDicts[id] ?? consentDicts.en),
          }))
          return () => { for (const dispose of disposers) dispose() }
        })
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register(
          {
            name: 'conversation.chat.reasoning.body',
            priority: 40,
            locale: NS,
            inject: () => ({
              hooks: { locale: ctx.locale },
              t,
            }),
          },
          AutoTranslatedBody,
        )))
      },
    }
  },
})
