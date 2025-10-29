import { BrowserWindow, ipcMain } from 'electron'
import { pathToFileURL } from 'url'

export interface HumanValidationArgs {
  prompt: string
  videoPath?: string
  previewUrl?: string
}

export interface HumanValidationOutcome {
  supported: boolean
  isCorrect?: boolean
  notes?: string
  tags?: string[]
  ts?: string
}

function genId(prefix = 'hv'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Request human validation via renderer modal.
 * Sends a one-off IPC message to renderer and awaits response on a unique channel.
 */
export async function requestHumanValidation(args: HumanValidationArgs): Promise<HumanValidationOutcome> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return { supported: false }

  const requestId = genId('human_validation')
  const respondChannel = `human_validation:respond:${requestId}`
  const videoSrc = args.previewUrl
    ? args.previewUrl
    : args.videoPath
    ? pathToFileURL(args.videoPath).toString()
    : undefined

  return new Promise<HumanValidationOutcome>((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ supported: false })
    }, 5 * 60 * 1000) // 5 minutes timeout

    ipcMain.once(respondChannel, (_evt, payload: { result?: HumanValidationOutcome }) => {
      clearTimeout(timeout)
      const r = payload?.result || ({} as HumanValidationOutcome)
      resolve({ supported: true, isCorrect: r.isCorrect, notes: r.notes, tags: r.tags, ts: r.ts })
    })

    win.webContents.send('human_validation:request', {
      requestId,
      prompt: args.prompt,
      videoSrc,
      previewUrl: args.previewUrl,
      videoPath: args.videoPath,
    })
  })
}