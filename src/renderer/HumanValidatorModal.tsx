import React, { useEffect, useMemo, useState } from 'react'

export interface HumanValidationResult {
  isCorrect: boolean
  notes?: string
  tags?: string[]
  ts: string
}

export default function HumanValidatorModal({
  open,
  onClose,
  videoSrc,
  prompt = '这是否是正确的视频？',
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  videoSrc?: string
  prompt?: string
  onSubmit?: (result: HumanValidationResult) => void
}) {
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null)
  const [notes, setNotes] = useState('')
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!open) {
      setIsCorrect(null)
      setNotes('')
      setSubmitted(false)
    }
  }, [open])

  const ts = useMemo(() => new Date().toISOString(), [submitted])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-lg font-semibold">人类验证员</h3>
          <button className="text-sm text-neutral-500 hover:text-neutral-800" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="w-full aspect-video bg-neutral-100 rounded flex items-center justify-center overflow-hidden">
            {videoSrc ? (
              <video src={videoSrc} controls className="w-full h-full" />
            ) : (
              <span className="text-neutral-500 text-sm">未提供视频预览</span>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{prompt}</label>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="isCorrect"
                  checked={isCorrect === true}
                  onChange={() => setIsCorrect(true)}
                />
                <span>是</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="isCorrect"
                  checked={isCorrect === false}
                  onChange={() => setIsCorrect(false)}
                />
                <span>否</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">观察/备注（可选）</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={isCorrect === false ? '例如：你爬下来的是一条广告视频' : '可填写任何补充说明'}
              className="w-full rounded border px-3 py-2 text-sm"
              rows={4}
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              className="px-3 py-2 text-sm rounded border hover:bg-neutral-50"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={isCorrect === null}
              onClick={() => {
                const result: HumanValidationResult = {
                  isCorrect: Boolean(isCorrect),
                  notes: notes.trim() || undefined,
                  tags: isCorrect ? ['HUMAN_OK'] : ['HUMAN_NOT_OK'],
                  ts: new Date().toISOString(),
                }
                setSubmitted(true)
                onSubmit?.(result)
                onClose()
              }}
            >
              提交反馈
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}