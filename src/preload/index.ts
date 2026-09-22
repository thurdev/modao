/*
 * Modão - a mod manager for the GTA games, built around Mod Loader.
 * Copyright (C) 2026 thurdev and contributors.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License for details: <https://www.gnu.org/licenses/>.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_PROGRESS, EVENT_TOAST, IPC_CHANNELS, type IpcChannel } from '@shared/ipc'
import type { Progress } from '@shared/types'

/**
 * The renderer gets exactly this surface: a fixed list of channels and two
 * event subscriptions. No fs, no net, no ipcRenderer, no remote module.
 */
function invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown> {
  if (!IPC_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
  }
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  invoke,
  onProgress(cb: (p: Progress) => void): () => void {
    const handler = (_e: unknown, p: Progress): void => cb(p)
    ipcRenderer.on(EVENT_PROGRESS, handler)
    return () => ipcRenderer.removeListener(EVENT_PROGRESS, handler)
  },
  /** Download progress, readiness and failure of an app update. */
  onUpdateEvent(
    cb: (event: { kind: 'progress' | 'ready' | 'error'; payload: unknown }) => void
  ): () => void {
    const channels: [string, 'progress' | 'ready' | 'error'][] = [
      ['event:updateProgress', 'progress'],
      ['event:updateReady', 'ready'],
      ['event:updateError', 'error']
    ]
    const handlers = channels.map(([channel, kind]) => {
      const handler = (_e: unknown, payload: unknown): void => cb({ kind, payload })
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    })
    return () => handlers.forEach((off) => off())
  },
  onToast(cb: (t: { kind: 'info' | 'error' | 'success'; message: string }) => void): () => void {
    const handler = (_e: unknown, t: { kind: 'info' | 'error' | 'success'; message: string }): void => cb(t)
    ipcRenderer.on(EVENT_TOAST, handler)
    return () => ipcRenderer.removeListener(EVENT_TOAST, handler)
  }
}

export type PreloadApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('modao', api)
} else {
  // contextIsolation is on in production; this branch only exists for dev tooling.
  ;(globalThis as unknown as { modao: PreloadApi }).modao = api
}
