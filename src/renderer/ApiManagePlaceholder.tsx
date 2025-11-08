import React, { useEffect, useMemo, useState } from 'react'
import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'

// 与 App.tsx 一致：在 Electron 环境下通过 window.require 获取 ipcRenderer；浏览器预览中为 null
const ipcRenderer: typeof import('electron').ipcRenderer | null = (() => {
  try {
    // @ts-ignore
    return window.require ? window.require('electron').ipcRenderer : null
  } catch {
    return null
  }
})()

type AgentName = 'coordinator' | 'static_parser' | 'network_capture'
type AgentConfig = { name: AgentName | string; apiKey: string; modelId: string }

const defaultModels: Record<AgentName, string> = {
  coordinator: 'doubao-seed-1-6-251015',
  static_parser: 'doubao-seed-1-6-251015',
  network_capture: 'doubao-seed-1-6-251015',
}

const displayNames: Record<AgentName, string> = {
  coordinator: '总协调员（生成式AI）',
  static_parser: '静态解析员（生成式AI）',
  network_capture: '网络抓包员（生成式AI）',
}

export default function ApiManagePlaceholder() {
  const [items, setItems] = useState<Record<AgentName, { apiKey: string; modelId: string }>>({
    coordinator: { apiKey: '', modelId: defaultModels.coordinator },
    static_parser: { apiKey: '', modelId: defaultModels.static_parser },
    network_capture: { apiKey: '', modelId: defaultModels.network_capture },
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')

  // 载入已有配置（含 .env 映射）
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        if (!ipcRenderer) {
          setStatus('当前在浏览器预览中，无法读取主进程配置。请在 Electron 中打开应用。')
          return
        }
        const list = (await ipcRenderer.invoke('agent:list')) as AgentConfig[]
        const byName: Record<string, AgentConfig> = {}
        ;(list || []).forEach((a) => (byName[a.name] = a))

        const doubao = (await ipcRenderer.invoke('agent:get', 'doubao')) as AgentConfig | null

        setItems((prev) => {
          const next = { ...prev }
          // 生成式：优先各自条目，其次 doubao，最后默认
          ;(['coordinator', 'static_parser', 'network_capture'] as AgentName[]).forEach((key) => {
            const exist = byName[key]
            next[key] = {
              apiKey: exist?.apiKey || doubao?.apiKey || prev[key].apiKey || '',
              modelId: exist?.modelId || doubao?.modelId || prev[key].modelId || defaultModels[key],
            }
          })
          // 已移除“向量处理（Embedding）”卡片与模块
          return next
        })
      } catch (err) {
        console.warn('加载 API 管理配置失败:', err)
      } finally {
        if (mounted) setStatus('')
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const cards = useMemo(() => (Object.keys(items) as AgentName[]), [items])

  async function handleSave() {
    setBusy(true)
    setStatus('正在保存并同步到 .env …')
    try {
      if (!ipcRenderer) {
        setStatus('当前在浏览器预览中，无法保存到 .env。请在 Electron 中打开应用。')
        return
      }
      // 依次 upsert 三个条目
      for (const name of cards) {
        const payload = { name, apiKey: items[name].apiKey || '', modelId: items[name].modelId || '' }
        await ipcRenderer.invoke('agent:upsert', payload)
      }
      // 同步一个标准 doubao 条目，保证程序默认生成式模型可用
      const primary = items.coordinator
      await ipcRenderer.invoke('agent:upsert', { name: 'doubao', apiKey: primary.apiKey || '', modelId: primary.modelId || '' })

      setStatus('已保存，已同步到 .env')
    } catch (err: any) {
      setStatus(`保存失败：${err?.message || String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">API 管理</h2>
        <Button disabled={busy || !ipcRenderer} onClick={handleSave}>
          {busy ? '保存中…' : '保存并同步到 .env'}
        </Button>
      </div>
      {status ? <p className="text-sm text-neutral-600 mb-3">{status}</p> : null}

      <div className="grid grid-cols-1 gap-4">
        {(Object.keys(items) as AgentName[]).map((name) => {
          const cfg = items[name]
          return (
            <div key={name} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="text-base font-medium">{displayNames[name]}</h3>
                <span className="text-xs text-neutral-500">默认模型：{defaultModels[name]}</span>
              </div>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs text-neutral-700">API Key</label>
                  <Input
                    value={cfg.apiKey}
                    onChange={(e) => setItems((prev) => ({ ...prev, [name]: { ...prev[name], apiKey: e.target.value } }))}
                    placeholder="请输入豆包 API Key"
                  />
                </div>
                <div>
                  <label className="text-xs text-neutral-700">Model ID</label>
                  <Input
                    value={cfg.modelId}
                    onChange={(e) => setItems((prev) => ({ ...prev, [name]: { ...prev[name], modelId: e.target.value } }))}
                    placeholder="例如 doubao-seed-1-6-251015"
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-neutral-500 mt-4">
        说明：生成式三项默认使用 doubao-seed-1-6-251015。保存后将写入 .env（不存在会创建），并应用到运行时。
      </p>
    </div>
  )
}