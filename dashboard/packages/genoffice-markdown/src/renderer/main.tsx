/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@polaris/genoffice-i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@polaris/genoffice-ui/tokens.css'
import '@polaris/genoffice-ui/screentip.css'
import '@polaris/genoffice-ui/dropdown.css'
import '@polaris/genoffice-ui/ribbon-collapse.css'
import '@polaris/genoffice-ui/markdown.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import { installScreenTips } from '@polaris/genoffice-ui'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.markdownApi.getLanguage().catch(() => 'zh' as const),
    window.markdownApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  applyTheme(theme)
  window.markdownApi.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
