import React, { useEffect, useMemo, useState } from 'react'
import ApiManagePlaceholder from './ApiManagePlaceholder'
import HumanValidatorModal from './HumanValidatorModal'
import HumanAcceptanceFlowModal, { type AcceptanceVariant } from './HumanAcceptanceFlowModal'
// 移除不存在的 App.css 引入
import * as Select from '@radix-ui/react-select'
import { ChevronDownIcon } from '@radix-ui/react-icons'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog'
import { Trash } from 'lucide-react'

const ipcRenderer: typeof import('electron').ipcRenderer | null = (() => {
  try {
    // @ts-ignore
    return window.require ? window.require('electron').ipcRenderer : null
  } catch {
    return null
  }
})()

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ')
}

function Nav({ view, setView }: { view: 'home' | 'make' | 'manage' | 'api'; setView: (v: 'home' | 'make' | 'manage' | 'api') => void }) {
  const item = (key: 'home' | 'make' | 'manage' | 'api', label: string) => (
    <button
      className={classNames(
        'px-3 py-2 rounded-md text-sm font-medium transition-colors',
        view === key ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'
      )}
      onClick={() => setView(key)}
    >
      {label}
    </button>
  )
  return (
    <div className="w-full border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between">
        <div className="text-lg font-semibold">AI 视频爬虫</div>
        <div className="flex items-center gap-2">
          {item('home', '主界面')}
          {item('make', '算法制作')}
          {item('manage', '算法管理')}
          {item('api', 'API管理')}
        </div>
      </div>
    </div>
  )
}

type AlgoInfo = { name: string; createdAt: number }

export default function App() {
  const [view, setView] = useState<'home' | 'make' | 'manage' | 'api'>('home')

  // 保存目录
  const [saveDir, setSaveDir] = useState<string | null>(null)

  // 算法列表（从后端请求），以及当前选择的算法
  const [algos, setAlgos] = useState<AlgoInfo[]>([])
  const [algo, setAlgo] = useState<string>('')

  const refreshAlgorithms = async () => {
    if (!ipcRenderer) return
    const list = await ipcRenderer.invoke('alg:list')
    setAlgos(list || [])
    // 如果当前选择已经被删除或为空，则默认选择第一个
    setAlgo((prev) => {
      if (!list || list.length === 0) return ''
      const exists = list.some((x: AlgoInfo) => x.name === prev)
      return exists ? prev : list[0].name
    })
  }

  useEffect(() => {
    refreshAlgorithms()
  }, [])

  // 在算法制作 finalize 成功后，主进程会广播 algorithms:updated，这里监听并刷新列表
  useEffect(() => {
    if (!ipcRenderer) return
    const onUpdated = (_e: any, _payload: any) => {
      refreshAlgorithms()
    }
    ipcRenderer.on('algorithms:updated', onUpdated)
    return () => {
      ipcRenderer.removeListener('algorithms:updated', onUpdated)
    }
  }, [])

  // 主界面逻辑
  const [url, setUrl] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [status, setStatus] = useState('')

  const isElectron = !!ipcRenderer

  // ===== 人类验证弹窗状态/接线 =====
  const [humanOpen, setHumanOpen] = useState(false)
  const [humanPrompt, setHumanPrompt] = useState<string>('这是否是正确的视频？')
  const [humanVideoSrc, setHumanVideoSrc] = useState<string | undefined>(undefined)
  const [humanRequestId, setHumanRequestId] = useState<string | null>(null)

  // 人类验收流程（变体选择）弹窗状态
  const [hafOpen, setHafOpen] = useState(false)
  const [hafPrompt, setHafPrompt] = useState<string>('请选择一个清单变体进行下载与验收')
  const [hafVariants, setHafVariants] = useState<AcceptanceVariant[]>([])
  const [hafRequestId, setHafRequestId] = useState<string | null>(null)

  useEffect(() => {
    if (!ipcRenderer) return
    const onHV = (_e: any, payload: any) => {
      setHumanRequestId(payload?.requestId || null)
      setHumanPrompt(payload?.prompt || '这是否是正确的视频？')
      setHumanVideoSrc(payload?.videoSrc || payload?.previewUrl)
      setHumanOpen(true)
    }
    ipcRenderer.on('human_validation:request', onHV)
    return () => {
      ipcRenderer.removeListener('human_validation:request', onHV)
    }
  }, [])

  const handleHumanSubmit = (result: { isCorrect: boolean; notes?: string; tags?: string[]; ts: string }) => {
    if (!ipcRenderer || !humanRequestId) return
    ipcRenderer.send(`human_validation:respond:${humanRequestId}`, { result })
    setHumanOpen(false)
  }

  // 接收人类验收流程的请求（展示变体选择弹窗）
  useEffect(() => {
    if (!ipcRenderer) return
    const onHAF = (_e: any, payload: any) => {
      setHafRequestId(payload?.requestId || null)
      setHafPrompt(payload?.prompt || '请选择一个清单变体进行下载与验收')
      setHafVariants(Array.isArray(payload?.variants) ? payload.variants : [])
      setHafOpen(true)
    }
    ipcRenderer.on('human_acceptance:request', onHAF)
    return () => {
      ipcRenderer.removeListener('human_acceptance:request', onHAF)
    }
  }, [])

  const handleHafSubmit = (variant: AcceptanceVariant) => {
    if (!ipcRenderer || !hafRequestId) return
    ipcRenderer.send(`human_acceptance:respond:${hafRequestId}`, { variant })
    setHafOpen(false)
  }

  const handleChooseSaveDir = async () => {
    if (!ipcRenderer) {
      alert('当前在浏览器预览中，无法选择保存目录。请通过 Electron 运行应用。')
      return
    }
    try {
      const res = await ipcRenderer.invoke('choose-save-dir')
      const dir = typeof res === 'string' ? res : (res && typeof res === 'object' ? res.path : null)
      if (dir) {
        setSaveDir(dir)
        setStatus(`已选择保存目录：${dir}`)
      } else {
        setStatus('未选择保存目录')
      }
    } catch (e: any) {
      setStatus('选择目录失败：' + (e?.message || '未知错误'))
    }
  }

  useEffect(() => {
    if (!ipcRenderer) return
    const onProgress = (_e: any, msg: string) => setStatus(msg)
    const onComplete = (_e: any, filePath: string) => {
      setStatus(`下载完成：${filePath}`)
      setDownloading(false)
    }
    const onError = (_e: any, errMsg: string) => {
      setStatus(`发生错误：${errMsg}`)
      setDownloading(false)
    }
    ipcRenderer.on('download-progress', onProgress)
    ipcRenderer.on('download-complete', onComplete)
    ipcRenderer.on('download-error', onError)
    return () => {
      ipcRenderer.removeListener('download-progress', onProgress)
      ipcRenderer.removeListener('download-complete', onComplete)
      ipcRenderer.removeListener('download-error', onError)
    }
  }, [])

  const handleStart = async () => {
    if (!ipcRenderer) {
      alert('当前在浏览器预览中，无法发起下载。请通过 Electron 运行应用。')
      return
    }
    if (!algo) {
      alert('请先选择一个算法')
      return
    }
    setDownloading(true)
    setStatus('开始处理...')
    ipcRenderer.send('start-download', { url, algo, saveDir })
  }

  // 算法管理视图
  function ManageView() {
    const [selectedAlgo, setSelectedAlgo] = useState<AlgoInfo | null>(null)
    const [code, setCode] = useState<string>('')

    const openCode = async (name: string) => {
      if (!ipcRenderer) return
      const detail = await ipcRenderer.invoke('alg:get', name)
      if (detail) {
        setSelectedAlgo({ name: detail.name, createdAt: detail.createdAt })
        setCode(detail.code || '')
      }
    }

    const deleteAlgo = async (name: string) => {
      if (!ipcRenderer) return
      // 美观确认可用 Dialog，这里先使用浏览器 confirm 简化
      const ok = window.confirm(`确认删除算法 “${name}” 吗？该操作不可恢复。`)
      if (!ok) return
      const res = await ipcRenderer.invoke('alg:delete', name)
      if (res?.success) {
        await refreshAlgorithms()
        // 如果删除了当前在主界面选择的算法，则调整主界面的选择
        setAlgo((prev) => {
          if (prev !== name) return prev
          return algos.length ? algos[0].name : ''
        })
      } else {
        alert(res?.message || '删除失败')
      }
    }

    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">算法管理</h2>
          <p className="text-sm text-neutral-600">查看、管理现有算法。点击查看代码，或删除算法。</p>
        </div>
        <div className="space-y-3">
          {algos.length === 0 && (
            <div className="text-neutral-600">暂无算法。</div>
          )}
          {algos.map((a) => (
            <div key={a.name} className="flex items-center justify-between rounded-md border border-neutral-200 p-3">
              <div>
                <div className="text-sm font-medium">{a.name}</div>
                <div className="text-xs text-neutral-500">{new Date(a.createdAt).toLocaleString()}</div>
              </div>
              <div className="flex items-center gap-2">
                <Dialog>
                  <DialogTrigger asChild>
                    <button className="px-3 py-1.5 rounded-md text-sm bg-neutral-900 text-white hover:bg-neutral-800">查看代码</button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>算法代码 - {a.name}</DialogTitle>
                      <DialogDescription>仅查看用途。</DialogDescription>
                    </DialogHeader>
                    <pre className="max-h-[50vh] overflow-auto rounded-md bg-neutral-950 text-neutral-100 p-4 text-xs">
{code}
                    </pre>
                    <DialogFooter>
                      <button
                        onClick={() => openCode(a.name)}
                        className="px-3 py-1.5 rounded-md text-sm bg-neutral-200 hover:bg-neutral-300"
                      >
                        刷新代码
                      </button>
                      <DialogTrigger asChild>
                        <button className="px-3 py-1.5 rounded-md text-sm bg-neutral-900 text-white">关闭</button>
                      </DialogTrigger>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <button
                  title="删除算法"
                  onClick={() => deleteAlgo(a.name)}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-sm bg-red-600 text-white hover:bg-red-700"
                >
                  <Trash className="w-4 h-4" /> 删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  function MakeView() {
    const [algoName, setAlgoName] = useState('')
    const [exampleUrl, setExampleUrl] = useState('')
    const [sourceCode, setSourceCode] = useState('')
    const [notes, setNotes] = useState('')
    const [runId, setRunId] = useState<string | null>(null)
    const [runStatus, setRunStatus] = useState<string>('')
    const [busy, setBusy] = useState(false)
    const [completedOnce, setCompletedOnce] = useState(false)

    const canSubmit = !!ipcRenderer && algoName.trim().length > 0 && exampleUrl.trim().length > 0

    const handleSubmit = async () => {
      if (!ipcRenderer) {
        alert('当前在浏览器预览中，无法启动智能体。请通过 Electron 运行应用。')
        return
      }
      // 提交前名称冲突检查：避免覆盖已有算法
      try {
        const list: AlgoInfo[] = await ipcRenderer.invoke('alg:list')
        const name = algoName.trim()
        if (name && Array.isArray(list) && list.some((x) => x.name === name)) {
          alert(`算法名已存在：${name}。请修改后再提交。`)
          return
        }
      } catch {}
      setBusy(true)
      setRunStatus('已提交，正在启动智能体...')
      try {
        // 如果之前已经完成过一轮，则在开启第二轮前清理缓存
        if (completedOnce) {
          try {
            const clean = await ipcRenderer.invoke('coordinatorLLM:cleanupCaches')
            // 可选：根据清理结果设置提示
            if (clean?.renamedRaw) {
              setRunStatus(`缓存已清理（raw 重命名：${clean.renamedRaw.split('\\').pop()}），正在启动...`)
            }
          } catch {}
        }
        const res = await ipcRenderer.invoke('coordinatorLLM:start', {
          algoName: algoName.trim(),
          url: exampleUrl.trim(),
          exampleUrl: exampleUrl.trim(),
          html: sourceCode,
          notes: notes.trim(),
          prefer: 'auto',
        })
        if (res?.error) {
          setRunId(null)
          setRunStatus('启动失败：' + String(res.error))
        } else {
          const rid = res?.runId || null
          setRunId(rid)
          setRunStatus(rid ? `运行ID：${rid}` : '启动失败')
        }
        // 第二轮开始后，重置 completedOnce 标记，由下一次完成设置
        if (completedOnce) setCompletedOnce(false)
      } catch (e: any) {
        setRunStatus('启动失败：' + (e?.message || '未知错误'))
      } finally {
        setBusy(false)
      }
    }

    useEffect(() => {
      if (!ipcRenderer) return
      if (!runId) return
      let mounted = true
      const timer = setInterval(async () => {
        if (!mounted) return
        try {
          const run = await ipcRenderer.invoke('coordinatorLLM:status', runId)
          if (run) {
            setRunStatus(`状态：${run.status}${run.result?.filePath ? ` | 文件：${run.result.filePath}` : ''}`)
            if (run.status === 'done' || run.status === 'error') {
              clearInterval(timer)
              // 一轮完成后：刷新界面到初始状态，允许用户进行第二轮制作
              setCompletedOnce(true)
              setAlgoName('')
              setExampleUrl('')
              setSourceCode('')
              setNotes('')
              setRunId(null)
              setBusy(false)
              setRunStatus(run.status === 'done' ? '已完成。界面已重置，可开始第二轮。' : '发生错误。界面已重置，可重试第二轮。')
            }
          }
        } catch {}
      }, 1500)
      return () => {
        mounted = false
        clearInterval(timer)
      }
    }, [runId])

    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <h2 className="text-xl font-semibold mb-2">算法制作</h2>
        <p className="text-sm text-neutral-600 mb-4">输入结构化信息后提交，作为智能体初始上下文。</p>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">算法名</label>
            <input
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="用于最终提交到算法存储的命名"
              value={algoName}
              onChange={(e) => setAlgoName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">示例网址</label>
            <input
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              placeholder="https://example.com/video"
              value={exampleUrl}
              onChange={(e) => setExampleUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">该网址的源代码（HTML）</label>
            <textarea
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              rows={8}
              placeholder="可粘贴页面 HTML 源代码，用于静态解析"
              value={sourceCode}
              onChange={(e) => setSourceCode(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">其他说明（可选）</label>
            <textarea
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
              rows={4}
              placeholder="可填写平台信息、鉴权要求、抓包提示等"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
            className={classNames(
              'px-4 py-2 rounded-md text-sm text-white',
              !canSubmit || busy ? 'bg-neutral-400' : 'bg-neutral-900 hover:bg-neutral-800'
            )}
          >
            {busy ? '提交中...' : '提交到智能体'}
          </button>
          <span className="text-sm text-neutral-600">{runStatus}</span>
        </div>
      </div>
    )
  }

  function HomeView() {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold">主界面</h2>
          <p className="text-sm text-neutral-600">输入网址、选择算法并开始爬取与下载。可选择保存目录。</p>
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">视频地址</label>
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
            placeholder="https://example.com/video"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">选择算法</label>
          <Select.Root value={algo} onValueChange={setAlgo}>
            <Select.Trigger className="inline-flex items-center justify-between rounded-md border border-neutral-300 px-3 py-2 text-sm w-64">
              <Select.Value placeholder={algos.length ? '请选择算法' : '暂无可选算法'} />
              <Select.Icon>
                <ChevronDownIcon />
              </Select.Icon>
            </Select.Trigger>
            <Select.Content className="rounded-md border border-neutral-300 bg-white shadow-md">
              <Select.Viewport className="p-1">
                {algos.map((a) => (
                  <Select.Item key={a.name} value={a.name} className="px-2 py-1.5 rounded hover:bg-neutral-100 text-sm cursor-pointer">
                    <Select.ItemText>{a.name}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Root>
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">保存目录</label>
          <div className="flex items-center gap-2">
            <button onClick={handleChooseSaveDir} className="px-3 py-1.5 rounded-md text-sm bg-neutral-900 text-white hover:bg-neutral-800">
              选择保存目录
            </button>
            <span className="text-sm text-neutral-600">{saveDir || '未选择，将使用默认 downloads/ 目录'}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={handleStart}
            disabled={downloading || !algo || !url}
            className={classNames(
              'px-4 py-2 rounded-md text-sm text-white',
              downloading || !algo || !url ? 'bg-neutral-400' : 'bg-neutral-900 hover:bg-neutral-800'
            )}
          >
            {downloading ? '处理中...' : '开始爬取并下载'}
          </button>
          <span className="text-sm text-neutral-600">{status}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <Nav view={view} setView={setView} />
      {view === 'home' && <HomeView />}
      {view === 'make' && <MakeView />}
      {view === 'manage' && <ManageView />}
      {view === 'api' && <ApiManagePlaceholder />}
      <HumanValidatorModal
        open={humanOpen}
        onClose={() => setHumanOpen(false)}
        videoSrc={humanVideoSrc}
        prompt={humanPrompt}
        onSubmit={handleHumanSubmit}
      />
      <HumanAcceptanceFlowModal
        open={hafOpen}
        onClose={() => setHafOpen(false)}
        variants={hafVariants}
        prompt={hafPrompt}
        onSubmit={handleHafSubmit}
      />
    </div>
  )
}