import { BrowserWindow, WebContentsView } from 'electron'
import { MESSAGING_SERVICES } from '@shared/defaults'
import { parseUnreadTitle } from '@shared/urls'
import type { MessagingService, MessagingState, Rect } from '@shared/types'
import type { PrivacyService } from '../privacy/privacy-service'

export { parseUnreadTitle as parseUnread } from '@shared/urls'

interface ServicePane {
  service: MessagingService
  view: WebContentsView
  state: MessagingState
}


export class MessagingHub {
  private panes = new Map<string, ServicePane>()
  private activeId: string | null = null
  private bounds: Rect | null = null
  private visible = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly privacy: PrivacyService,
    private readonly onChange: () => void
  ) {}

  get services(): MessagingService[] {
    return MESSAGING_SERVICES
  }

  get active(): string | null {
    return this.activeId
  }

  states(): MessagingState[] {
    return MESSAGING_SERVICES.map((service) => {
      const pane = this.panes.get(service.id)
      return (
        pane?.state ?? {
          id: service.id,
          opened: false,
          unread: 0,
          title: '',
          loading: false,
          failed: false,
          lastError: null
        }
      )
    })
  }

  open(serviceId: string): MessagingState {
    const service = MESSAGING_SERVICES.find((entry) => entry.id === serviceId)
    if (!service) throw new Error(`Unknown messaging service: ${serviceId}`)

    let pane = this.panes.get(serviceId)
    if (!pane) {
      const ses = this.privacy.createIsolatedSession(`msg-${serviceId}`, 'first-party')
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: true,
          backgroundThrottling: false,
          disableDialogs: true,
          additionalArguments: [`--warden-service=${serviceId}`]
        }
      })
      view.setBackgroundColor('#0b0e12')
      this.win.contentView.addChildView(view)

      pane = {
        service,
        view,
        state: {
          id: serviceId,
          opened: true,
          unread: 0,
          title: service.name,
          loading: true,
          failed: false,
          lastError: null
        }
      }
      this.panes.set(serviceId, pane)

      const wc = view.webContents
      wc.on('page-title-updated', (_event, title) => {
        if (!pane) return
        pane.state.title = title
        pane.state.unread = parseUnreadTitle(title)
        this.onChange()
      })
      wc.on('did-start-loading', () => {
        if (!pane) return
        pane.state.loading = true
        this.onChange()
      })
      wc.on('did-stop-loading', () => {
        if (!pane) return
        pane.state.loading = false
        this.onChange()
      })
      wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (!pane || !isMainFrame || code === -3) return
        pane.state.failed = true
        pane.state.lastError = `${description} (${code}) ${url}`
        pane.state.loading = false
        this.onChange()
      })
      wc.on('did-navigate', (_event, url) => {
        if (!pane) return
        pane.state.failed = false
        pane.state.title = url
        this.onChange()
      })
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) {
          wc.loadURL(url).catch(() => undefined)
        }
        return { action: 'deny' }
      })
      wc.on('will-navigate', (event, url) => {
        if (!/^https?:/i.test(url)) event.preventDefault()
      })

      view.webContents.loadURL(service.url).catch(() => undefined)
    }

    this.activeId = serviceId
    this.showOnly(serviceId)
    this.onChange()
    return pane.state
  }

  close(serviceId: string): void {
    const pane = this.panes.get(serviceId)
    if (!pane) return
    this.panes.delete(serviceId)
    try {
      this.win.contentView.removeChildView(pane.view)
      pane.view.webContents.close()
    } catch {
      /* already detached */
    }
    if (this.activeId === serviceId) {
      this.activeId = this.panes.keys().next().value ?? null
      if (this.activeId) this.showOnly(this.activeId)
    }
    this.onChange()
  }

  activate(serviceId: string): void {
    const pane = this.panes.get(serviceId)
    if (!pane) return
    this.activeId = serviceId
    this.showOnly(serviceId)
    pane.view.webContents.focus()
    this.onChange()
  }

  reload(serviceId: string): void {
    this.panes.get(serviceId)?.view.webContents.reload()
  }

  focusActive(): void {
    if (!this.activeId) return
    this.panes.get(this.activeId)?.view.webContents.focus()
  }

  private showOnly(serviceId: string | null): void {
    for (const [id, pane] of this.panes) {
      const isActive = id === serviceId && this.visible
      pane.view.setVisible(isActive)
      if (isActive) this.applyBounds(pane)
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.showOnly(this.activeId)
  }

  setBounds(bounds: Rect | null): void {
    this.bounds = bounds
    if (this.activeId) {
      const pane = this.panes.get(this.activeId)
      if (pane) this.applyBounds(pane)
    }
  }

  private applyBounds(pane: ServicePane): void {
    if (!this.bounds || !this.visible) return
    const { x, y, width, height } = this.bounds
    if (width < 40 || height < 40) return
    pane.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }

  closeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id)
  }
}
