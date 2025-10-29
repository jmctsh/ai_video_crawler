import React, { useEffect, useMemo, useState } from 'react'

export type AcceptanceVariant = {
  id: string
  kind: 'hls' | 'dash' | 'direct'
  url?: string
  name?: string
  res?: { width: number; height: number }
  br?: number
  sizeApproxBytes?: number
  notes?: string
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}

function kindLabel(kind: 'hls' | 'dash' | 'direct') {
  if (kind === 'hls') return 'HLS'
  if (kind === 'dash') return 'DASH'
  return '直链'
}

export default function HumanAcceptanceFlowModal({
  open,
  onClose,
  variants,
  prompt = '请选择一个清单变体进行下载与验收',
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  variants: AcceptanceVariant[]
  prompt?: string
  onSubmit?: (variant: AcceptanceVariant) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) setSelectedId(null)
  }, [open])

  const selected = useMemo(() => variants.find((v) => v.id === selectedId) || null, [selectedId, variants])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-lg font-semibold">人类验收流程 · 选择变体</h3>
          <button className="text-sm text-neutral-500 hover:text-neutral-800" onClick={onClose}>关闭</button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">{prompt}</label>
            {variants.length === 0 && (
              <div className="text-sm text-neutral-600">无可用清单变体。</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {variants.map((v) => (
                <label key={v.id} className="relative cursor-pointer rounded-md border border-neutral-200 hover:border-neutral-400 transition-colors">
                  <input
                    type="radio"
                    name="variant"
                    className="absolute opacity-0"
                    checked={selectedId === v.id}
                    onChange={() => setSelectedId(v.id)}
                  />
                  <div className={"p-3 space-y-1 " + (selectedId === v.id ? 'bg-blue-50 border-blue-300' : '')}>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">{v.name || `${v.res ? `${v.res.width}x${v.res.height}` : '未知分辨率'}`}</div>
                      <div className="text-xs rounded px-2 py-0.5 bg-neutral-100 text-neutral-700">{kindLabel(v.kind)}</div>
                    </div>
                    <div className="text-xs text-neutral-600">
                      <span>分辨率：{v.res ? `${v.res.width}x${v.res.height}` : '-'}</span>
                      {' · '}
                      <span>码率：{typeof v.br === 'number' ? `${v.br.toFixed(2)} Mbps` : '-'}</span>
                      {' · '}
                      <span>预计大小：{formatBytes(v.sizeApproxBytes)}</span>
                    </div>
                    {v.notes && (
                      <div className="text-[11px] text-neutral-500">{v.notes}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <button className="px-3 py-2 text-sm rounded border hover:bg-neutral-50" onClick={onClose}>取消</button>
            <button
              className="px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={!selected}
              onClick={() => selected && onSubmit?.(selected)}
            >
              提交选择
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}