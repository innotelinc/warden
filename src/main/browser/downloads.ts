import { app } from 'electron'
import path from 'node:path'
import type { DownloadItem } from '@shared/types'

export class DownloadManager {
  private items: DownloadItem[] = []
  private counter = 0

  constructor(private readonly onChange: () => void) {}

  list(): DownloadItem[] {
    return this.items.slice(0, 30)
  }

  track(item: Electron.DownloadItem): void {
    this.counter += 1
    const id = `dl-${this.counter}`
    const filename = item.getFilename()
    if (!item.getSavePath()) {
      const unique = `${Date.now().toString(36)}-${filename}`.replace(/[\\/:*?"<>|]/g, '_')
      item.setSavePath(path.join(app.getPath('downloads'), unique))
    }

    const record: DownloadItem = {
      id,
      filename,
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      savePath: item.getSavePath()
    }
    this.items = [record, ...this.items].slice(0, 40)
    this.onChange()

    item.on('updated', (_event, state) => {
      record.received = item.getReceivedBytes()
      record.total = item.getTotalBytes()
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      this.onChange()
    })

    item.once('done', (_event, state) => {
      record.state = state
      record.received = item.getReceivedBytes()
      record.total = item.getTotalBytes()
      this.onChange()
    })
  }
}
